// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite is the store; Effect has no synchronous SQLite client.
import * as NodeSqlite from "node:sqlite";

import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { RelayAgentActivityState as RelayAgentActivityStateSchema } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { TargetRow } from "./cardDelivery.ts";

export class PushStoreError extends Schema.TaggedError<PushStoreError>()("PushStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `t3-push storage failed during ${this.operation}.`;
  }
}

type LiveActivityKind = "live_activity_update" | "live_activity_end";

/**
 * The SQLite state of one owner. Every method is synchronous so a caller can
 * read the rows and act on them, or store a row and queue its delivery, with
 * no other request interleaved: the push model treats each as one step.
 */
export class PushStore extends Context.Service<
  PushStore,
  {
    readonly upsertRow: (state: RelayAgentActivityState) => void;
    readonly deleteRow: (input: {
      readonly environmentId: string;
      readonly threadId: string;
    }) => void;
    readonly listRows: () => ReadonlyArray<RelayAgentActivityState>;
    readonly pruneTerminalRows: (updatedBefore: string) => void;
    readonly registerDevice: (registration: RelayDeviceRegistrationRequest, now: string) => void;
    readonly unregisterDevice: (deviceId: string) => void;
    readonly registerLiveActivity: (
      registration: RelayLiveActivityRegistrationRequest,
      now: string,
    ) => void;
    readonly listTargets: () => ReadonlyArray<TargetRow>;
    readonly getTarget: (deviceId: string) => TargetRow | null;
    /** Write-ahead: persists the aggregate about to be sent and returns the one it replaces. */
    readonly beginSend: (input: {
      readonly deviceId: string;
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState | null;
    }) => string | null;
    readonly restoreSent: (input: {
      readonly deviceId: string;
      readonly token: string;
      readonly sentAggregateJson: string | null;
    }) => void;
    readonly recordDelivery: (input: {
      readonly deviceId: string;
      readonly token: string;
      readonly kind: LiveActivityKind;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly deliveredAt: string;
    }) => void;
    readonly invalidateToken: (input: {
      readonly deviceId: string;
      readonly token: string;
      readonly kind: LiveActivityKind | "push_notification";
      readonly invalidatedAt: string;
    }) => void;
  }
>()("@t3tools/push/PushStore") {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS activity_rows (
  environment_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (environment_id, thread_id)
) STRICT;
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  platform TEXT NOT NULL,
  ios_major_version INTEGER,
  app_version TEXT,
  bundle_id TEXT,
  aps_environment TEXT,
  push_token TEXT UNIQUE,
  push_to_start_token TEXT UNIQUE,
  preferences_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS live_activities (
  device_id TEXT PRIMARY KEY,
  activity_push_token TEXT UNIQUE,
  remote_started_at TEXT,
  ended_at TEXT,
  last_aggregate_json TEXT,
  last_live_activity_delivery_at TEXT,
  sent_aggregate_json TEXT,
  send_unsure INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;
`;

const TARGET_SELECT = `
SELECT d.device_id, d.platform, d.bundle_id, d.aps_environment, d.push_token, d.preferences_json,
  la.activity_push_token, la.remote_started_at, la.last_aggregate_json,
  la.last_live_activity_delivery_at, la.sent_aggregate_json, coalesce(la.send_unsure, 0) AS send_unsure
FROM devices d LEFT JOIN live_activities la ON la.device_id = d.device_id`;

const decodeStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityStateSchema),
);

type SqlRow = Record<string, NodeSqlite.SQLOutputValue>;
const text = (row: SqlRow, column: string) => {
  const value = row[column];
  return typeof value === "string" ? value : null;
};

function toTarget(row: SqlRow): TargetRow {
  const environment = text(row, "aps_environment");
  return {
    device_id: text(row, "device_id") ?? "",
    platform: text(row, "platform") === "android" ? "android" : "ios",
    bundle_id: text(row, "bundle_id"),
    aps_environment: environment === "sandbox" || environment === "production" ? environment : null,
    push_token: text(row, "push_token"),
    preferences_json: text(row, "preferences_json") ?? "{}",
    activity_push_token: text(row, "activity_push_token"),
    remote_started_at: text(row, "remote_started_at"),
    last_aggregate_json: text(row, "last_aggregate_json"),
    last_live_activity_delivery_at: text(row, "last_live_activity_delivery_at"),
    sent_aggregate_json: text(row, "sent_aggregate_json"),
    send_unsure: Number(row.send_unsure) === 1,
  };
}

const aggregateJson = (aggregate: RelayAgentActivityAggregateState | null) =>
  aggregate === null ? null : JSON.stringify(aggregate);

function make(db: NodeSqlite.DatabaseSync): PushStore["Service"] {
  db.exec("PRAGMA journal_mode = WAL");
  // The write-ahead record must reach disk before the APNs send it guards.
  db.exec("PRAGMA synchronous = FULL");
  db.exec(SCHEMA);

  const transaction = (run: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const upsertRow = db.prepare(`
    INSERT INTO activity_rows (environment_id, thread_id, phase, state_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (environment_id, thread_id) DO UPDATE SET
      phase = excluded.phase, state_json = excluded.state_json, updated_at = excluded.updated_at`);
  const deleteRow = db.prepare(
    "DELETE FROM activity_rows WHERE environment_id = ? AND thread_id = ?",
  );
  const listRows = db.prepare("SELECT state_json FROM activity_rows");
  const pruneTerminalRows = db.prepare(
    "DELETE FROM activity_rows WHERE phase IN ('completed', 'failed') AND updated_at < ?",
  );
  const releasePushToken = db.prepare(
    "UPDATE devices SET push_token = NULL, updated_at = ? WHERE push_token = ?",
  );
  const releasePushToStartToken = db.prepare(
    "UPDATE devices SET push_to_start_token = NULL, updated_at = ? WHERE push_to_start_token = ?",
  );
  // Older builds must preserve newer routing fields on re-registration.
  const upsertDevice = db.prepare(`
    INSERT INTO devices (device_id, label, platform, ios_major_version, app_version, bundle_id,
      aps_environment, push_token, push_to_start_token, preferences_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (device_id) DO UPDATE SET
      label = excluded.label,
      platform = excluded.platform,
      ios_major_version = excluded.ios_major_version,
      app_version = excluded.app_version,
      bundle_id = coalesce(excluded.bundle_id, devices.bundle_id),
      aps_environment = coalesce(excluded.aps_environment, devices.aps_environment),
      push_token = coalesce(excluded.push_token, devices.push_token),
      push_to_start_token = coalesce(excluded.push_to_start_token, devices.push_to_start_token),
      preferences_json = excluded.preferences_json,
      updated_at = excluded.updated_at`);
  const deleteLiveActivity = db.prepare("DELETE FROM live_activities WHERE device_id = ?");
  const deleteDevice = db.prepare("DELETE FROM devices WHERE device_id = ?");
  const currentLiveActivity = db.prepare(
    "SELECT activity_push_token, remote_started_at FROM live_activities WHERE device_id = ?",
  );
  const releaseActivityToken = db.prepare(`
    UPDATE live_activities SET activity_push_token = NULL, remote_started_at = NULL,
      ended_at = ?, updated_at = ?
    WHERE activity_push_token = ?`);
  const upsertLiveActivity = db.prepare(`
    INSERT INTO live_activities (device_id, activity_push_token, remote_started_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (device_id) DO UPDATE SET
      activity_push_token = excluded.activity_push_token,
      remote_started_at = excluded.remote_started_at,
      ended_at = NULL,
      last_aggregate_json = NULL,
      last_live_activity_delivery_at = NULL,
      sent_aggregate_json = NULL,
      send_unsure = 0,
      updated_at = excluded.updated_at`);
  const listTargets = db.prepare(TARGET_SELECT);
  const getTarget = db.prepare(`${TARGET_SELECT} WHERE d.device_id = ?`);
  const sentAggregate = db.prepare(
    "SELECT sent_aggregate_json FROM live_activities WHERE device_id = ? AND activity_push_token = ?",
  );
  const beginSend = db.prepare(`
    UPDATE live_activities SET sent_aggregate_json = ?, send_unsure = 1
    WHERE device_id = ? AND activity_push_token = ?`);
  const restoreSent = db.prepare(`
    UPDATE live_activities SET sent_aggregate_json = ?
    WHERE device_id = ? AND activity_push_token = ?`);
  const recordUpdate = db.prepare(`
    UPDATE live_activities SET last_aggregate_json = ?, last_live_activity_delivery_at = ?,
      send_unsure = 0, updated_at = ?
    WHERE device_id = ? AND activity_push_token = ?`);
  // An ended card takes no more updates: drop its token, as LiveActivities.markDelivery does.
  const recordEnd = db.prepare(`
    UPDATE live_activities SET activity_push_token = NULL, ended_at = ?, last_aggregate_json = ?,
      last_live_activity_delivery_at = ?, send_unsure = 0, updated_at = ?
    WHERE device_id = ? AND activity_push_token = ?`);
  const invalidatePushToken = db.prepare(
    "UPDATE devices SET push_token = NULL, updated_at = ? WHERE device_id = ? AND push_token = ?",
  );
  const invalidateActivityToken = db.prepare(`
    UPDATE live_activities SET activity_push_token = NULL, remote_started_at = NULL,
      ended_at = ?, send_unsure = 0, updated_at = ?
    WHERE device_id = ? AND activity_push_token = ?`);

  return PushStore.of({
    upsertRow: (state) => {
      upsertRow.run(
        state.environmentId,
        state.threadId,
        state.phase,
        JSON.stringify(state),
        state.updatedAt,
      );
    },
    deleteRow: (input) => {
      deleteRow.run(input.environmentId, input.threadId);
    },
    listRows: () =>
      listRows.all().flatMap((row) => Option.toArray(decodeStateJson(text(row, "state_json")))),
    pruneTerminalRows: (updatedBefore) => {
      pruneTerminalRows.run(updatedBefore);
    },
    registerDevice: (registration, now) =>
      transaction(() => {
        if (registration.pushToken) releasePushToken.run(now, registration.pushToken);
        if (registration.pushToStartToken) {
          releasePushToStartToken.run(now, registration.pushToStartToken);
        }
        upsertDevice.run(
          registration.deviceId,
          registration.label,
          registration.platform,
          registration.iosMajorVersion ?? null,
          registration.appVersion ?? null,
          registration.bundleId ?? null,
          registration.apsEnvironment ?? null,
          registration.pushToken ?? null,
          registration.pushToStartToken ?? null,
          JSON.stringify(registration.preferences),
          now,
          now,
        );
      }),
    unregisterDevice: (deviceId) =>
      transaction(() => {
        deleteLiveActivity.run(deviceId);
        deleteDevice.run(deviceId);
      }),
    registerLiveActivity: (registration, now) =>
      transaction(() => {
        const current = currentLiveActivity.get(registration.deviceId);
        // Foreground token refresh must retain the original arming time or grace can swallow an owed end event.
        const armedAt =
          (current && text(current, "activity_push_token") === registration.activityPushToken
            ? text(current, "remote_started_at")
            : null) ?? now;
        releaseActivityToken.run(now, now, registration.activityPushToken);
        upsertLiveActivity.run(registration.deviceId, registration.activityPushToken, armedAt, now);
      }),
    listTargets: () => listTargets.all().map(toTarget),
    getTarget: (deviceId) => {
      const row = getTarget.get(deviceId);
      return row === undefined ? null : toTarget(row);
    },
    beginSend: (input) => {
      const row = sentAggregate.get(input.deviceId, input.token);
      const previous = row === undefined ? null : text(row, "sent_aggregate_json");
      beginSend.run(aggregateJson(input.aggregate), input.deviceId, input.token);
      return previous;
    },
    restoreSent: (input) => {
      restoreSent.run(input.sentAggregateJson, input.deviceId, input.token);
    },
    recordDelivery: (input) => {
      const json = aggregateJson(input.aggregate);
      if (input.kind === "live_activity_end") {
        recordEnd.run(
          input.deliveredAt,
          json,
          input.deliveredAt,
          input.deliveredAt,
          input.deviceId,
          input.token,
        );
      } else {
        recordUpdate.run(json, input.deliveredAt, input.deliveredAt, input.deviceId, input.token);
      }
    },
    invalidateToken: (input) => {
      if (input.kind === "push_notification") {
        invalidatePushToken.run(input.invalidatedAt, input.deviceId, input.token);
      } else {
        invalidateActivityToken.run(
          input.invalidatedAt,
          input.invalidatedAt,
          input.deviceId,
          input.token,
        );
      }
    },
  });
}

/** Opens `path` (`:memory:` in tests) for the layer's lifetime. */
export const layer = (path: string) =>
  Layer.effect(
    PushStore,
    Effect.acquireRelease(
      Effect.try({
        try: () => new NodeSqlite.DatabaseSync(path),
        catch: (cause) => new PushStoreError({ operation: "open", cause }),
      }),
      (db) => Effect.sync(() => db.close()),
    ).pipe(
      Effect.flatMap((db) =>
        Effect.try({
          try: () => make(db),
          catch: (cause) => new PushStoreError({ operation: "migrate", cause }),
        }),
      ),
    ),
  );
