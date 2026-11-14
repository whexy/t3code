// Copied from infra/relay/src/agentActivity/ApnsDeliveries.ts (chooseDelivery and its helpers),
// which loads Drizzle, Alchemy and Cloudflare queues at import time. Keep it in step; each
// difference is a rule of .agents/skills/verify-self-hosted-push/SKILL.md and says so below.
import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import {
  RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateSchema,
  RelayAgentAwarenessPreferences as RelayAgentAwarenessPreferencesSchema,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeAggregateState } from "../../../infra/relay/src/agentActivity/agentActivityAggregate.ts";
import {
  alertForActivityRows,
  attentionTransitionRows,
  rowPhasesChanged,
  shouldAlertForActivity,
  terminalTransitionRows,
} from "../../../infra/relay/src/agentActivity/agentActivityAlerts.ts";
import {
  isTerminalPhase,
  MAX_SUMMARY_TEXT_LENGTH,
  notificationForActivity,
  truncateText,
} from "../../../infra/relay/src/agentActivity/agentActivityPayloads.ts";
import { alertSound } from "../../../infra/relay/src/agentActivity/alertSound.ts";
import type * as Apns from "../../../infra/relay/src/agentActivity/ApnsClient.ts";
import type {
  ApnsLiveActivityAlert,
  ApnsNotificationPayload,
} from "../../../infra/relay/src/agentActivity/apnsDeliveryJobs.ts";
import type { ApnsCredentials } from "../../../infra/relay/src/Config.ts";

const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
// Two names plus the longest phase words and separator stay within MAX_SUMMARY_TEXT_LENGTH.
const MAX_NAME_IN_COMBINED_ALERT = 45;
const FRESHLY_ARMED_GRACE_MS = 2 * 60 * 1_000;
const PERMANENT_APNS_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

/** Upstream's `LiveActivities.TargetRow`, plus the write-ahead send state. */
export interface TargetRow {
  readonly device_id: string;
  readonly platform: "ios" | "android";
  readonly bundle_id: string | null;
  readonly aps_environment: "sandbox" | "production" | null;
  readonly push_token: string | null;
  readonly preferences_json: string;
  readonly activity_push_token: string | null;
  readonly remote_started_at: string | null;
  readonly last_aggregate_json: string | null;
  readonly last_live_activity_delivery_at: string | null;
  readonly sent_aggregate_json: string | null;
  readonly send_unsure: boolean;
  /** An end was chosen and APNs has not yet accepted one. */
  readonly end_pending: boolean;
}

export type CardDelivery =
  | {
      readonly kind: "live_activity_update";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState;
      readonly alert: ApnsLiveActivityAlert | null;
      /** The rows the alert rings for. */
      readonly alerted: ReadonlyArray<RelayAgentActivityAggregateRow>;
    }
  | {
      readonly kind: "live_activity_end";
      readonly token: string;
      readonly aggregate: null;
      readonly alert: null;
    };

export type ChosenDelivery =
  | CardDelivery
  | {
      readonly kind: "push_notification";
      readonly token: string;
      readonly notification: ApnsNotificationPayload;
    };

const decodeRelayAgentActivityAggregateStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityAggregateStateSchema),
);
const decodeRelayAgentAwarenessPreferencesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferencesSchema),
);

function parseAggregate(value: string | null): RelayAgentActivityAggregateState | null {
  if (!value) {
    return null;
  }
  return Option.getOrNull(decodeRelayAgentActivityAggregateStateJson(value));
}

function parsePreferences(value: string): RelayAgentAwarenessPreferences | null {
  return Option.getOrNull(decodeRelayAgentAwarenessPreferencesJson(value));
}

function epochMillis(iso: string | null): number | null {
  return iso === null
    ? null
    : Option.match(DateTime.make(iso), {
        onNone: () => Number.NaN,
        onSome: (dt) => dt.epochMilliseconds,
      });
}

function aggregateNeedsAttention(aggregate: RelayAgentActivityAggregateState): boolean {
  return aggregate.activities.some(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
}

function shouldUpdateLiveActivity(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly lastDeliveryAt: string | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previousAggregate) {
    return true;
  }
  if (JSON.stringify(input.previousAggregate) === JSON.stringify(input.nextAggregate)) {
    return false;
  }
  if (input.previousAggregate.activeCount !== input.nextAggregate.activeCount) {
    return true;
  }
  if (aggregateNeedsAttention(input.nextAggregate)) {
    return true;
  }
  // Phase and row changes may be the last update until the next transition.
  // Throttling them would leave the card showing a stale state indefinitely.
  if (rowPhasesChanged(input.previousAggregate, input.nextAggregate)) {
    return true;
  }
  const lastDeliveryAtMs = epochMillis(input.lastDeliveryAt);
  return (
    lastDeliveryAtMs === null ||
    Number.isNaN(lastDeliveryAtMs) ||
    input.nowMs - lastDeliveryAtMs >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}

function notificationForAggregate(input: {
  readonly target: TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): ApnsNotificationPayload | null {
  if (!input.target.push_token || input.aggregate === null) {
    return null;
  }
  const preferences = parsePreferences(input.target.preferences_json);
  if (!preferences?.notificationsEnabled) {
    return null;
  }
  const activity = input.aggregate.activities[0];
  if (!activity) {
    return null;
  }
  if (!shouldAlertForActivity({ ...activity, preferences, nowMs: input.nowMs })) return null;
  return notificationForActivity(activity);
}

// Differs: the grace ends at the first recorded delivery, as the push model's `armed`.
function isFreshlyArmed(target: TargetRow, nowMs: number): boolean {
  const armedAtMs = epochMillis(target.remote_started_at);
  return (
    target.last_live_activity_delivery_at === null &&
    armedAtMs !== null &&
    nowMs - armedAtMs < FRESHLY_ARMED_GRACE_MS
  );
}

interface AlertedRows {
  readonly attention: ReadonlyArray<RelayAgentActivityAggregateRow>;
  readonly terminal: ReadonlyArray<RelayAgentActivityAggregateRow>;
}

const NO_ALERTED_ROWS: AlertedRows = { attention: [], terminal: [] };

// Differs: upstream rings for completions only when nothing newly asks, so a completion delivered with an ask is never alerted.
function alertedRows(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences;
  readonly nowMs: number;
}): AlertedRows {
  return {
    attention: attentionTransitionRows(input),
    terminal: terminalTransitionRows({ ...input, includeUnobserved: true }),
  };
}

function phaseWords(row: RelayAgentActivityAggregateRow): string {
  switch (row.phase) {
    case "waiting_for_approval":
      return "needs approval";
    case "waiting_for_input":
      return "needs input";
    case "failed":
      return "failed";
    default:
      return "done";
  }
}

export function alertForAlertedRows(rows: AlertedRows): ApnsLiveActivityAlert | null {
  const alert = alertTextForAlertedRows(rows);
  return (
    alert && {
      ...alert,
      sound: alertSound([...rows.attention, ...rows.terminal].map((row) => row.phase)),
    }
  );
}

/** One alert for both kinds, asks first; a single kind keeps upstream's text. */
function alertTextForAlertedRows(rows: AlertedRows): ApnsLiveActivityAlert | null {
  const { attention, terminal } = rows;
  const asking = attention[0];
  const finished = terminal[0];
  if (!asking || !finished) return alertForActivityRows(asking ? attention : terminal);
  if (attention.length === 1 && terminal.length === 1) {
    const name = (row: RelayAgentActivityAggregateRow) =>
      `${truncateText(row.threadTitle, MAX_NAME_IN_COMBINED_ALERT)} ${phaseWords(row)}`;
    return {
      title: `${name(asking)} · ${name(finished)}`,
      body: truncateText(
        `${asking.status}: ${asking.projectTitle} · ${finished.status}: ${finished.projectTitle}`,
        MAX_SUMMARY_TEXT_LENGTH,
      ),
    };
  }
  const agents = attention.length === 1 ? "agent needs" : "agents need";
  return {
    title: `${attention.length} ${agents} attention · ${terminal.length} finished`,
    body: truncateText(
      [...attention, ...terminal].map((row) => row.threadTitle).join(", "),
      MAX_SUMMARY_TEXT_LENGTH,
    ),
  };
}

const endDelivery = (token: string): CardDelivery => ({
  kind: "live_activity_end",
  token,
  aggregate: null,
  alert: null,
});

// Suppressed Live Activity updates must not fall back to alert pushes or unchanged replays would ring.
function chooseLiveActivityDelivery(input: {
  readonly target: TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): CardDelivery | "suppressed" | null {
  const token = input.target.activity_push_token;
  // Differs (EndIsFinal): an end that may have arrived is resent until APNs accepts one, so no
  // update or alert goes to a card the phone may no longer show.
  if (token && input.target.end_pending) {
    return endDelivery(token);
  }
  const preferences = parsePreferences(input.target.preferences_json);
  if (preferences?.liveActivitiesEnabled === false) {
    return token ? endDelivery(token) : null;
  }
  if (!token) {
    return null;
  }
  if (input.aggregate === null) {
    // Registration replay can precede a new thread's first publish; preserve a freshly armed card until state arrives.
    if (isFreshlyArmed(input.target, input.nowMs)) {
      return null;
    }
    return endDelivery(token);
  }
  const nextAggregate = input.aggregate;
  const recordedAggregate = parseAggregate(input.target.last_aggregate_json);
  // Differs (WriteAheadSend): alerts compare with the last sent aggregate, which a crash or
  // timeout may have left unrecorded. A card with no recorded baseline gets no alert.
  const alertBaseline =
    recordedAggregate === null
      ? null
      : (parseAggregate(input.target.sent_aggregate_json) ?? recordedAggregate);
  // Differs (WriteAheadSend): an unrecorded send may have changed the card, so skip nothing.
  const update =
    input.target.send_unsure ||
    shouldUpdateLiveActivity({
      previousAggregate: recordedAggregate,
      nextAggregate,
      lastDeliveryAt: input.target.last_live_activity_delivery_at,
      nowMs: input.nowMs,
    });
  if (!update) {
    return "suppressed";
  }
  // Differs (ReplayAlertsFromBaseline): a replay alerts too. Upstream silences replays because it
  // keeps no record of what it last sent; sent_aggregate_json is that record, so a replay cannot
  // re-ring an alert that may already be on the phone.
  const alerted = preferences?.notificationsEnabled
    ? alertedRows({
        previousAggregate: alertBaseline,
        nextAggregate,
        preferences,
        nowMs: input.nowMs,
      })
    : NO_ALERTED_ROWS;
  return {
    kind: "live_activity_update",
    token,
    aggregate: nextAggregate,
    alert: alertForAlertedRows(alerted),
    alerted: [...alerted.attention, ...alerted.terminal],
  };
}

// Differs: never falls back to a notification. A phone without a card is notified per publish
// by notificationForPublish, as upstream's notification-only path; upstream's fallback alerts
// about the aggregate's first row, which may be another thread's.
export function chooseDelivery(input: {
  readonly target: TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): CardDelivery | null {
  const liveActivityDelivery = chooseLiveActivityDelivery(input);
  return liveActivityDelivery === "suppressed" ? null : liveActivityDelivery;
}

/** Alerts ride on the card; without one, or while it is ending, they go out as notifications. */
export function hasCard(target: TargetRow): boolean {
  return (
    target.activity_push_token !== null &&
    !target.end_pending &&
    parsePreferences(target.preferences_json)?.liveActivitiesEnabled !== false
  );
}

/** AgentActivityPublisher's `notificationOnlyAggregate`: built from the published state alone. */
export function notificationForPublish(input: {
  readonly target: TargetRow;
  readonly state: RelayAgentActivityState;
  readonly nowMs: number;
}): ChosenDelivery | null {
  const terminal = isTerminalPhase(input.state);
  const notification = notificationForAggregate({
    target: input.target,
    aggregate: makeAggregateState({
      activeStates: terminal ? [] : [input.state],
      terminalState: terminal ? input.state : null,
      nowMs: input.nowMs,
    }),
    nowMs: input.nowMs,
  });
  return notification && input.target.push_token
    ? { kind: "push_notification", token: input.target.push_token, notification }
    : null;
}

export function isPermanentApnsTokenFailure(result: Apns.ApnsDeliveryResult): boolean {
  return (
    !result.ok &&
    (result.status === 410 ||
      (result.status === 400 &&
        result.reason !== undefined &&
        PERMANENT_APNS_TOKEN_REASONS.has(result.reason)))
  );
}

// Bundle ids and APS environments vary by build; route per device to avoid DeviceTokenNotForTopic/BadDeviceToken.
export function credentialsForTarget(
  credentials: Omit<ApnsCredentials, "bundleId"> & { readonly bundleId: string | null },
  target: Pick<TargetRow, "bundle_id" | "aps_environment">,
): ApnsCredentials | null {
  const bundleId = target.bundle_id ?? credentials.bundleId;
  return bundleId === null
    ? null
    : {
        ...credentials,
        bundleId,
        ...(target.aps_environment ? { environment: target.aps_environment } : {}),
      };
}
