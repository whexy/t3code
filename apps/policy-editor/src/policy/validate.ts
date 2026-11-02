import {
  ManagedPolicyDocument,
  ManagedPolicyLimits,
  ManagedPolicySetting,
  ManagedProviderLimits,
  RuntimeMode,
  ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { makeManagedProviders } from "../../../server/src/policy/managedProviders.ts";
import { makeManagedSettings } from "../../../server/src/policy/managedSettings.ts";
import { BUILT_IN_SETTINGS, HIDDEN_SETTINGS, nearestRow, rowForKey } from "./catalog.ts";
import { isRecord, setPath } from "./json.ts";

export type ProblemTarget =
  | { readonly kind: "document"; readonly key?: string }
  | { readonly kind: "setting"; readonly key: string }
  | { readonly kind: "limit"; readonly key: string; readonly entry?: string };

export interface Problem {
  readonly target: ProblemTarget;
  readonly severity: "error" | "warning";
  readonly message: string;
  /** The schema's own account, when the server's reason is general. */
  readonly detail?: string;
}

export interface Verdict {
  readonly problems: ReadonlyArray<Problem>;
  /** No errors: `t3 policy check` accepts the file, and it names only settings the editor shows. */
  readonly valid: boolean;
  /** What `t3 policy check` on macOS or Linux reports; undefined when it accepts the file. */
  readonly serverReason: string | undefined;
}

type Settings = Record<string, ManagedPolicySetting>;
type Platform = "linux" | "win32";

// As the server reads a policy file: a key it does not know might be a restriction it cannot enforce.
const STRICT = { onExcessProperty: "error" } as const;
const decodeDocument = Schema.decodeUnknownExit(ManagedPolicyDocument, STRICT);
const decodeSetting = Schema.decodeUnknownExit(ManagedPolicySetting, STRICT);
const decodeProviderLimits = Schema.decodeUnknownExit(ManagedProviderLimits, STRICT);
const decodeRuntimeMode = Schema.decodeUnknownExit(RuntimeMode);
const decodeSettings = Schema.decodeUnknownExit(ServerSettings);

function schemaMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return Schema.isSchemaError(error) ? error.message.replace(/\s*\n\s*/g, " ") : String(error);
}

/** Why one key of a struct's fields rejects `value`, in the schema's words. */
function fieldProblem(fields: Schema.Struct.Fields, key: string, value: unknown) {
  const field = fields[key];
  if (field === undefined) return undefined;
  // Every policy field decodes without services; the record of fields cannot say so.
  const one = Schema.Struct({ [key]: field as Schema.Codec<unknown> });
  const exit = Schema.decodeExit(one, STRICT)({ [key]: value });
  return Exit.isSuccess(exit) ? undefined : schemaMessage(exit.cause);
}

/** Where the document breaks the policy schema, as close to the offending key as it can say. */
function schemaProblems(document: Record<string, unknown>): Problem[] {
  const problems: Problem[] = [];
  const error = (target: ProblemTarget, message: string) =>
    problems.push({ target, severity: "error", message });
  const top = ManagedPolicyDocument.fields;
  for (const key of Object.keys(document)) {
    if (!(key in top)) error({ kind: "document", key }, `A policy has no "${key}" key.`);
  }
  if (document.schemaVersion === undefined) {
    error({ kind: "document", key: "schemaVersion" }, "schemaVersion is required, and must be 1.");
  }
  if (document.organization === undefined) {
    error({ kind: "document", key: "organization" }, "The organization's name is required.");
  }
  for (const key of ["schemaVersion", "organization", "supportUrl"] as const) {
    if (document[key] === undefined) continue;
    const message = fieldProblem(top, key, document[key]);
    if (message !== undefined) error({ kind: "document", key }, message);
  }
  const { settings, limits } = document;
  if (settings !== undefined) {
    if (!isRecord(settings)) error({ kind: "document", key: "settings" }, "settings is an object.");
    else {
      for (const [key, entry] of Object.entries(settings)) {
        const exit = decodeSetting(entry);
        if (Exit.isFailure(exit)) {
          error(
            { kind: "setting", key },
            `Each setting is { "value": …, "locked": true or false }: ${schemaMessage(exit.cause)}`,
          );
        }
      }
    }
  }
  if (limits !== undefined) {
    if (!isRecord(limits)) error({ kind: "document", key: "limits" }, "limits is an object.");
    else {
      for (const [key, value] of Object.entries(limits)) {
        if (!(key in ManagedPolicyLimits.fields)) {
          error({ kind: "limit", key }, `limits has no "${key}" key.`);
          continue;
        }
        const message = fieldProblem(ManagedPolicyLimits.fields, key, value);
        if (message !== undefined) error({ kind: "limit", key }, message);
      }
    }
  }
  return problems;
}

/** Each entry the server refuses, with its reason: the first refusal, then the next without it. */
function settingsProblems(entries: Settings, maxRuntimeMode: RuntimeMode | undefined): Problem[] {
  const problems: Problem[] = [];
  const remaining: Settings = { ...entries };
  for (let round = 0; round <= Object.keys(entries).length; round += 1) {
    const result = makeManagedSettings(remaining, maxRuntimeMode);
    if (result._tag === "Valid") break;
    const culprits = culpritsOf(result.reason, remaining, maxRuntimeMode);
    if (culprits.length === 0) {
      problems.push({ target: { kind: "document" }, severity: "error", message: result.reason });
      break;
    }
    for (const key of culprits) {
      const detail = typeDetail(key, remaining[key]?.value);
      problems.push({
        target: { kind: "setting", key },
        severity: "error",
        message: result.reason,
        ...(detail === undefined ? {} : { detail }),
      });
      delete remaining[key];
    }
  }
  return problems;
}

function culpritsOf(
  reason: string,
  entries: Settings,
  maxRuntimeMode: RuntimeMode | undefined,
): ReadonlyArray<string> {
  // Most reasons open with the path they refuse, or with the setting it belongs to.
  const named = /^"([^"]+)"/.exec(reason)?.[1];
  if (named !== undefined) {
    if (named in entries) return [named];
    const within = Object.keys(entries).filter((key) => key.split(".")[0] === named);
    if (within.length > 0) return within;
  }
  // The rest name no path; find the entries the server refuses on their own for that reason.
  return Object.keys(entries).filter((key) => {
    const entry = entries[key];
    if (entry === undefined) return false;
    const alone = makeManagedSettings({ [key]: entry }, maxRuntimeMode);
    return alone._tag === "Invalid" && alone.reason === reason;
  });
}

/** Why the settings schema rejects `value` at `key`, which the server reports only in general. */
function typeDetail(key: string, value: unknown): string | undefined {
  const exit = decodeSettings(setPath(BUILT_IN_SETTINGS, key.split("."), value));
  return Exit.isFailure(exit) ? schemaMessage(exit.cause) : undefined;
}

const providersCheck = (
  limits: ManagedProviderLimits,
  maxRuntimeMode: RuntimeMode | undefined,
  platform: Platform,
) => {
  const result = makeManagedProviders(limits, maxRuntimeMode, platform);
  return result._tag === "Invalid" ? result.reason : undefined;
};

/**
 * Each provider limit the server refuses. A refusal only on Windows, where variable names ignore
 * case, is a warning: `t3 policy check` on macOS or Linux accepts it.
 */
function providersProblems(
  limits: ManagedProviderLimits,
  maxRuntimeMode: RuntimeMode | undefined,
): Problem[] {
  for (const platform of ["linux", "win32"] as const) {
    const reason = providersCheck(limits, maxRuntimeMode, platform);
    if (reason === undefined) continue;
    const severity = platform === "win32" ? "warning" : "error";
    const say = (text: string) =>
      platform === "win32" ? `On Windows, where variable names ignore case, ${text}` : text;
    const problems: Problem[] = [];
    if (limits.allowedDrivers !== undefined) {
      const alone = providersCheck(
        { allowedDrivers: limits.allowedDrivers },
        maxRuntimeMode,
        platform,
      );
      if (alone !== undefined) {
        problems.push({
          target: { kind: "limit", key: "providers.allowedDrivers" },
          severity,
          message: say(alone),
        });
      }
    }
    for (const [driver, pin] of Object.entries(limits.instances ?? {})) {
      const alone = providersCheck(
        { instances: Object.fromEntries([[driver, pin]]) },
        maxRuntimeMode,
        platform,
      );
      if (alone !== undefined) {
        problems.push({
          target: { kind: "limit", key: "providers.instances", entry: driver },
          severity,
          message: say(alone),
        });
      }
    }
    return problems.length > 0
      ? problems
      : [{ target: { kind: "limit", key: "providers" }, severity, message: say(reason) }];
  }
  return [];
}

/** Why the editor refuses a key the server accepts: it is not one the editor shows. */
function unshownReason(key: string): string {
  const hidden = HIDDEN_SETTINGS.get(key);
  const remove = `t3 policy check accepts "${key}", but this editor manages only what is a user's choice, so remove it.`;
  if (hidden !== undefined) return `${hidden} ${remove}`;
  const row = nearestRow(key);
  if (row !== undefined && row.path.startsWith(`${key}.`)) {
    return `The editor manages "${key}" one field at a time, as T3's Settings page shows it. Remove "${key}" and set its fields instead.`;
  }
  if (row !== undefined) {
    return `The editor manages "${row.path}" as one value. Remove "${key}" and set "${row.path}" instead.`;
  }
  return `"${key}" is not a setting this editor shows. Remove it.`;
}

/** Check a policy document by the rules `t3 policy check` applies, plus the editor's own one. */
export function validatePolicy(document: unknown): Verdict {
  if (!isRecord(document)) {
    const message = "A policy is a JSON object.";
    return {
      problems: [{ target: { kind: "document" }, severity: "error", message }],
      valid: false,
      serverReason: message,
    };
  }
  const problems: Problem[] = [];
  const decoded = decodeDocument(document);
  if (Exit.isFailure(decoded)) {
    const located = schemaProblems(document);
    problems.push(
      ...(located.length > 0
        ? located
        : [
            {
              target: { kind: "document" },
              severity: "error",
              message: schemaMessage(decoded.cause),
            } satisfies Problem,
          ]),
    );
  }

  // Run the server's checks on whatever parts decode, so every problem shows at once.
  const limits = isRecord(document.limits) ? document.limits : {};
  const ceiling = decodeRuntimeMode(limits.maxRuntimeMode);
  const maxRuntimeMode = Exit.isSuccess(ceiling) ? ceiling.value : undefined;
  const rawSettings = isRecord(document.settings) ? document.settings : {};
  const settings: Settings = {};
  for (const [key, entry] of Object.entries(rawSettings)) {
    const exit = decodeSetting(entry);
    if (Exit.isSuccess(exit)) settings[key] = exit.value;
  }
  problems.push(...settingsProblems(settings, maxRuntimeMode));
  const providerLimits = decodeProviderLimits(limits.providers ?? {});
  if (
    Exit.isSuccess(providerLimits) &&
    (limits.providers !== undefined || maxRuntimeMode !== undefined)
  ) {
    problems.push(...providersProblems(providerLimits.value, maxRuntimeMode));
  }

  for (const key of Object.keys(settings)) {
    const flagged = problems.some(
      (problem) => problem.target.kind === "setting" && problem.target.key === key,
    );
    if (!flagged && rowForKey(key) === undefined) {
      problems.push({
        target: { kind: "setting", key },
        severity: "error",
        message: unshownReason(key),
      });
    }
  }

  return {
    problems,
    valid: !problems.some((problem) => problem.severity === "error"),
    serverReason: serverReason(decoded),
  };
}

/** The first refusal, in the order `ManagedPolicy.fromDocument` checks. */
function serverReason(decoded: Exit.Exit<ManagedPolicyDocument, unknown>): string | undefined {
  if (Exit.isFailure(decoded)) return "does not match the policy schema";
  const document = decoded.value;
  const maxRuntimeMode = document.limits?.maxRuntimeMode;
  const settings = makeManagedSettings(document.settings ?? {}, maxRuntimeMode);
  if (settings._tag === "Invalid") return settings.reason;
  const providerLimits = document.limits?.providers;
  if (providerLimits === undefined && maxRuntimeMode === undefined) return undefined;
  return providersCheck(providerLimits ?? {}, maxRuntimeMode, "linux");
}
