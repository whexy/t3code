import {
  AuthMcpClientAccess,
  AuthSessionId,
  EnvironmentId,
  managedPolicyDeniedMessage,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadCallbackInput,
  type OrchestratorMcpThreadCallbackResult,
  OrchestratorMcpWaitCallback,
  OrchestratorMcpWaitCallbackEvent,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { callbackFetch, callbackUrlProblem } from "./waitCallbackAddress.ts";

const STORE_SECRET = "mcp-wait-callbacks";
const CALLBACK_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CALLBACKS = 256;
const POST_TIMEOUT = Duration.seconds(15);
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;

const McpCapabilityName = Schema.Literals([
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
] satisfies ReadonlyArray<McpInvocationContext.McpCapability>);

/** Enough of the arming caller to wait again as them after a restart, with the same checks. */
const StoredCallback = Schema.Struct({
  id: Schema.String,
  expiresAt: Schema.Number,
  scope: Schema.Struct({
    environmentId: EnvironmentId,
    capabilities: Schema.Array(McpCapabilityName),
    issuedAt: Schema.Number,
    requestNamespace: Schema.String,
    client: Schema.Struct({
      sessionId: AuthSessionId,
      label: Schema.String,
      access: AuthMcpClientAccess,
      hostedAppUrl: Schema.optional(Schema.String),
      narrowedTo: Schema.optional(
        Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
      ),
    }),
  }),
  wait: Schema.Struct({
    threadId: ThreadId,
    runId: Schema.optional(RunId),
    untilDelegatedWorkSettled: Schema.optional(Schema.Boolean),
  }),
  callback: OrchestratorMcpWaitCallback,
  link: Schema.String,
  /** Fixed once the wait ends, so a resend after a restart repeats the same event. */
  event: Schema.optional(OrchestratorMcpWaitCallbackEvent),
});
type StoredCallback = typeof StoredCallback.Type;

const StoredCallbacksJson = Schema.fromJsonString(Schema.Array(StoredCallback));
const decodeStored = Schema.decodeUnknownEffect(StoredCallbacksJson);
const encodeStored = Schema.encodeEffect(StoredCallbacksJson);

const keyFor = (sessionId: string, threadId: ThreadId) => `${sessionId}\u0000${threadId}`;
const keyOf = (record: StoredCallback) =>
  keyFor(record.scope.client.sessionId, record.wait.threadId);

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

export interface WaitCallbacksShape {
  /** Arms `input.callback` for this wait, or cancels the caller's callback for the thread when null. */
  readonly set: (
    scope: McpInvocationContext.McpInvocationScope,
    input: OrchestratorMcpThreadCallbackInput,
  ) => Effect.Effect<OrchestratorMcpThreadCallbackResult, OrchestratorMcpFailure>;
  /** Resumes stored callbacks after a restart. */
  readonly start: () => Effect.Effect<void>;
}

// Only server.ts provides the real service; toolkit tests build /mcp without it.
export class WaitCallbacks extends Context.Reference<WaitCallbacksShape>("t3/mcp/WaitCallbacks", {
  defaultValue: () => ({
    set: () =>
      Effect.fail(failure("capability_denied", "Wait callbacks are not available on this server.")),
    start: () => Effect.void,
  }),
}) {}

/** `McpSchema.EnabledWhen`: an agent in a T3 thread gets results as messages instead. */
export const onlyForOutsideClients = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.thread === undefined && scope?.client?.linked !== true;
};

const retryAfterMs = (header: string | undefined, now: number): number | undefined => {
  if (header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
};

type Delivery = "delivered" | "retry" | "refused";

const classify = (status: number): Delivery =>
  status >= 200 && status < 300
    ? "delivered"
    : status === 408 || status === 425 || status === 429 || status >= 500
      ? "retry"
      : "refused";

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* SessionStore.SessionStore;
  const orchestratorMcp = yield* OrchestratorMcpService.OrchestratorMcpService;
  const random = yield* SecureRandom.SecureRandom;
  const http = yield* HttpClient.HttpClient;
  const policyOrganization = ManagedPolicy.deniedBy(
    yield* ManagedPolicy.ManagedPolicy,
    "webhookTasks",
  );
  const running = yield* FiberMap.make<string>();
  const storeLock = yield* Semaphore.make(1);

  // Writes fail on an unreadable store rather than replace it; only `start` reads past it.
  const loadStore = secrets
    .get(STORE_SECRET)
    .pipe(
      Effect.flatMap((bytes) =>
        Option.isNone(bytes)
          ? Effect.succeed<ReadonlyArray<StoredCallback>>([])
          : decodeStored(new TextDecoder().decode(bytes.value)),
      ),
    );
  const readStore = loadStore.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Wait callbacks could not be read; starting with none.", cause).pipe(
        Effect.as<ReadonlyArray<StoredCallback>>([]),
      ),
    ),
  );
  const writeStore = (records: ReadonlyArray<StoredCallback>) =>
    encodeStored(records).pipe(
      Effect.flatMap((json) =>
        records.length === 0
          ? secrets.remove(STORE_SECRET)
          : secrets.set(STORE_SECRET, new TextEncoder().encode(json)),
      ),
    );
  const update = <A>(
    change: (records: ReadonlyArray<StoredCallback>) => readonly [A, ReadonlyArray<StoredCallback>],
  ) =>
    storeLock.withPermits(1)(
      Effect.gen(function* () {
        const [result, next] = change(yield* loadStore);
        yield* writeStore(next);
        return result;
      }),
    );
  const removeRecord = (id: string) =>
    update((records) => [undefined, records.filter((record) => record.id !== id)]).pipe(
      Effect.catch((cause) => Effect.logWarning("A wait callback could not be removed.", cause)),
    );

  const scopeOf = (record: StoredCallback): McpInvocationContext.McpInvocationScope => ({
    environmentId: record.scope.environmentId,
    capabilities: new Set(record.scope.capabilities),
    issuedAt: record.scope.issuedAt,
    requestNamespace: record.scope.requestNamespace,
    thread: undefined,
    client: record.scope.client,
  });

  const waitUntilDone = Effect.fn("WaitCallbacks.waitUntilDone")(function* (
    record: StoredCallback,
  ) {
    const scope = scopeOf(record);
    // waitForThread caps each wait at an hour, so a day-long callback waits in pieces.
    while (true) {
      const remaining = record.expiresAt - (yield* Clock.currentTimeMillis);
      const result = yield* orchestratorMcp.waitForThread(scope, {
        ...record.wait,
        timeoutMs: Math.max(1, remaining),
      });
      if (!result.timedOut || (yield* Clock.currentTimeMillis) >= record.expiresAt) return result;
    }
  });

  const eventFor = Effect.fn("WaitCallbacks.eventFor")(function* (record: StoredCallback) {
    const outcome = yield* waitUntilDone(record).pipe(Effect.result);
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      event: "thread.wait" as const,
      eventId: record.id,
      environmentId: record.scope.environmentId,
      threadId: record.wait.threadId,
      link: record.link,
      occurredAt,
    };
    return outcome._tag === "Success"
      ? { ...base, result: outcome.success }
      : { ...base, error: outcome.failure.message };
  });

  const post = (record: StoredCallback, event: OrchestratorMcpWaitCallbackEvent) =>
    http
      .execute(
        HttpClientRequest.post(record.callback.url).pipe(
          HttpClientRequest.setHeaders(
            Object.fromEntries(
              (record.callback.headers ?? []).map((header) => [header.name, header.value]),
            ),
          ),
          HttpClientRequest.bodyJsonUnsafe(event),
        ),
      )
      .pipe(
        Effect.timeout(POST_TIMEOUT),
        Effect.provideService(FetchHttpClient.Fetch, callbackFetch()),
        Effect.map((response) => ({
          delivery: classify(response.status),
          status: response.status,
          retryAfter: response.headers["retry-after"],
        })),
        Effect.catch((cause) =>
          Effect.succeed({
            delivery: "retry" as const,
            status: undefined,
            retryAfter: undefined,
            cause,
          }),
        ),
      );

  const deliver = Effect.fn("WaitCallbacks.deliver")(function* (
    record: StoredCallback,
    event: OrchestratorMcpWaitCallbackEvent,
  ) {
    const firstAttemptAt = yield* Clock.currentTimeMillis;
    for (let attempt = 0; ; attempt++) {
      const sent = yield* post(record, event);
      if (sent.delivery === "delivered") return;
      if (sent.delivery === "refused") {
        return yield* Effect.logWarning(
          `A wait callback was refused with HTTP ${sent.status}; it will not be sent again.`,
        );
      }
      const now = yield* Clock.currentTimeMillis;
      const delay = Math.min(
        MAX_RETRY_DELAY_MS,
        retryAfterMs(sent.retryAfter, now) ??
          RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!,
      );
      if (now + delay - firstAttemptAt > RETRY_WINDOW_MS) {
        return yield* Effect.logWarning("A wait callback was not delivered within a day.");
      }
      yield* Effect.sleep(Duration.millis(delay));
    }
  });

  const runCallback = (record: StoredCallback) =>
    Effect.raceFirst(
      // A revoked or expired client keeps nothing running for it.
      sessions
        .awaitInvalidation(record.scope.client.sessionId)
        .pipe(Effect.catch(() => Effect.never)),
      Effect.gen(function* () {
        let event = record.event;
        if (event === undefined) {
          const ended = yield* eventFor(record);
          event = ended;
          yield* update((records) => [
            undefined,
            records.map((stored) =>
              stored.id === record.id ? { ...stored, event: ended } : stored,
            ),
          ]).pipe(
            Effect.catch((cause) => Effect.logWarning("A wait result was not saved.", cause)),
          );
        }
        yield* deliver(record, event);
      }),
      // Not on interruption: a shutdown must leave the record for `start` to resume.
    ).pipe(Effect.andThen(removeRecord(record.id)));

  const set: WaitCallbacksShape["set"] = Effect.fn("WaitCallbacks.set")(function* (scope, input) {
    const callback = input.callback;
    const client = scope.client;
    if (scope.thread !== undefined || client === undefined || client.linked === true) {
      return yield* failure(
        "invalid_request",
        "callback is for MCP clients outside T3 Code. An agent in a T3 thread gets results as messages.",
      );
    }
    if (client.access === "read-only") {
      return yield* failure(
        "capability_denied",
        "A callback makes this environment send requests, and this MCP client was approved for read-only access.",
      );
    }
    if (policyOrganization !== undefined) {
      return yield* failure(
        "capability_denied",
        managedPolicyDeniedMessage(policyOrganization, "webhooks"),
      );
    }
    const key = keyFor(client.sessionId, input.threadId);
    // Also checks the caller may read the thread, before anything is stored.
    const current = yield* orchestratorMcp.waitForThread(scope, {
      threadId: input.threadId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.untilDelegatedWorkSettled === true ? { untilDelegatedWorkSettled: true } : {}),
      timeoutMs: 1,
    });
    if (callback === null) {
      yield* FiberMap.remove(running, key);
      yield* update((records) => [
        undefined,
        records.filter((record) => keyOf(record) !== key),
      ]).pipe(
        Effect.mapError(() => failure("orchestration_error", "The callback could not be removed.")),
      );
      return { ...current, callback: null };
    }
    const problem = callbackUrlProblem(callback.url);
    if (problem !== undefined) return yield* failure("invalid_request", problem);

    const id = yield* random
      .uuidV4()
      .pipe(Effect.mapError(() => failure("orchestration_error", "Unable to arm the callback.")));
    const expiresAt = (yield* Clock.currentTimeMillis) + CALLBACK_TTL_MS;
    // Pin the run, so a later turn does not move the wait after a restart.
    const runId = input.runId ?? current.runId ?? undefined;
    const record: StoredCallback = {
      id,
      expiresAt,
      scope: {
        environmentId: scope.environmentId,
        capabilities: [...scope.capabilities],
        issuedAt: scope.issuedAt,
        requestNamespace: scope.requestNamespace,
        client: {
          sessionId: AuthSessionId.make(client.sessionId),
          label: client.label,
          access: client.access,
          ...(client.hostedAppUrl === undefined ? {} : { hostedAppUrl: client.hostedAppUrl }),
          ...(client.narrowedTo === undefined ? {} : { narrowedTo: client.narrowedTo }),
        },
      },
      wait: {
        threadId: input.threadId,
        ...(runId === undefined ? {} : { runId }),
        ...(input.untilDelegatedWorkSettled === true ? { untilDelegatedWorkSettled: true } : {}),
      },
      callback,
      link: McpInvocationContext.threadLinkFor(scope, input.threadId),
    };
    yield* update((records): readonly [boolean, ReadonlyArray<StoredCallback>] => {
      const others = records.filter((stored) => keyOf(stored) !== key);
      return others.length >= MAX_CALLBACKS ? [false, records] : [true, [...others, record]];
    }).pipe(
      Effect.mapError(() => failure("orchestration_error", "The callback could not be saved.")),
      Effect.filterOrFail(
        (saved) => saved,
        () =>
          failure("invalid_request", `This environment already has ${MAX_CALLBACKS} callbacks.`),
      ),
    );
    yield* FiberMap.run(running, key, runCallback(record));
    return {
      ...current,
      callback: { id, expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)) },
    };
  });

  const start: WaitCallbacksShape["start"] = Effect.fn("WaitCallbacks.start")(function* () {
    for (const record of yield* readStore) {
      yield* FiberMap.run(running, keyOf(record), runCallback(record), { onlyIfMissing: true });
    }
  });

  return { set, start } satisfies WaitCallbacksShape;
});

export const layer = Layer.effect(WaitCallbacks, make).pipe(Layer.provide(FetchHttpClient.layer));
