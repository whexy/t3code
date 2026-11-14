import { ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { callbackUrlProblem, layerCallbackHttp } from "./callbackAddress.ts";
import { BridgeError, Environments, type T3Environment } from "./environment.ts";
import { turnEnded, workingRunIds } from "./threadWatch.ts";

const CALLBACK_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CALLBACKS = 256;
/** One watch per socket; a day-long callback watches in pieces. */
const WATCH_CHUNK_MS = 10 * 60 * 1_000;
/** A paired server restarts on every fleet update, so an unreachable one is waited out. */
const UNREACHABLE_RETRY = Duration.seconds(30);
const POST_TIMEOUT = Duration.seconds(15);
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export const CallbackTarget = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)).annotate({
    description: "An https URL that accepts a JSON POST.",
  }),
  headers: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/)),
          value: Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^[^\r\n]*$/)),
        }),
      )
        .check(Schema.isMaxLength(8))
        .annotate({
          description: "Sent with every POST, such as Authorization. Never shown again.",
        }),
    ),
  ),
});
export type CallbackTarget = typeof CallbackTarget.Type;

/** What the bridge POSTs: the get_session_status result, or why there is none. */
const CallbackEvent = Schema.Struct({
  event: Schema.Literal("session.status"),
  event_id: Schema.String,
  server_id: Schema.String,
  session_id: Schema.String,
  occurred_at: Schema.String,
  status: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.String),
});
type CallbackEvent = typeof CallbackEvent.Type;

const StoredCallback = Schema.Struct({
  id: Schema.String,
  serverId: Schema.String,
  sessionId: Schema.String,
  url: Schema.String,
  headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  cursor: Schema.optional(Schema.String),
  /** The runs underway when it was set, so a restart waits on the same turn. */
  runIds: Schema.Array(Schema.String),
  expiresAt: Schema.Number,
  /** Fixed once the wait ends, so a resend after a restart repeats the same event. */
  event: Schema.optional(CallbackEvent),
});
type StoredCallback = typeof StoredCallback.Type;

const storeCodec = Schema.fromJsonString(Schema.Array(StoredCallback));
const decodeStore = Schema.decodeUnknownEffect(storeCodec);
const encodeStore = Schema.encodeEffect(storeCodec);

export interface ArmedCallback {
  readonly callback_id: string;
  readonly expires_at: string;
}

/** The get_session_status result for a projection, as JSON. */
export type StatusReport = (
  environment: T3Environment,
  projection: OrchestrationV2ThreadProjection,
  options: { readonly cursor: string | undefined; readonly timedOut: boolean },
) => Effect.Effect<Schema.Json>;

export class SessionCallbacks extends Context.Service<
  SessionCallbacks,
  {
    /** Arms `callback` for the session's current turn, replacing any; null cancels it. */
    readonly set: (input: {
      readonly serverId: string;
      readonly sessionId: string;
      readonly cursor: string | undefined;
      readonly callback: CallbackTarget | null;
    }) => Effect.Effect<
      {
        readonly environment: T3Environment;
        readonly projection: OrchestrationV2ThreadProjection;
        readonly armed: ArmedCallback | null;
      },
      BridgeError
    >;
    readonly armed: (serverId: string, sessionId: string) => Effect.Effect<ArmedCallback | null>;
  }
>()("@t3tools/mcp/callbacks/SessionCallbacks") {}

const keyFor = (serverId: string, sessionId: string) => `${serverId}\u0000${sessionId}`;
const keyOf = (record: StoredCallback) => keyFor(record.serverId, record.sessionId);
const armedOf = (record: StoredCallback): ArmedCallback => ({
  callback_id: record.id,
  expires_at: DateTime.formatIso(DateTime.makeUnsafe(record.expiresAt)),
});

const retryAfterMs = (header: string | undefined, now: number): number | undefined => {
  if (header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
};

const classify = (status: number) =>
  status >= 200 && status < 300
    ? ("delivered" as const)
    : status === 408 || status === 425 || status === 429 || status >= 500
      ? ("retry" as const)
      : ("refused" as const);

/** Callbacks live in `<dataDir>/callbacks.json`, readable only by its owner, and resume on start. */
export const make = Effect.fn("SessionCallbacks.make")(function* (options: {
  readonly dataDir: string;
  readonly report: StatusReport;
}) {
  const environments = yield* Environments;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const http = yield* HttpClient.HttpClient;
  const file = path.join(options.dataDir, "callbacks.json");

  yield* fileSystem.makeDirectory(options.dataDir, { recursive: true });
  const initial = (yield* fileSystem.exists(file))
    ? yield* fileSystem.readFileString(file).pipe(
        Effect.flatMap(decodeStore),
        Effect.catch((cause) =>
          Effect.logWarning("Session callbacks could not be read; starting with none.", cause).pipe(
            Effect.as<ReadonlyArray<StoredCallback>>([]),
          ),
        ),
      )
    : [];
  const records = yield* Ref.make(initial);
  const lock = yield* Semaphore.make(1);
  const running = yield* FiberMap.make<string>();

  const update = Effect.fn("SessionCallbacks.update")(function* <A>(
    change: (current: ReadonlyArray<StoredCallback>) => readonly [A, ReadonlyArray<StoredCallback>],
  ) {
    const [result, next] = change(yield* Ref.get(records));
    yield* fileSystem.writeFileString(`${file}.tmp`, yield* encodeStore(next), { mode: 0o600 });
    yield* fileSystem.rename(`${file}.tmp`, file);
    yield* Ref.set(records, next);
    return result;
  }, Semaphore.withPermit(lock));
  const remove = (id: string) =>
    update((current) => [undefined, current.filter((record) => record.id !== id)]).pipe(
      Effect.catch((cause) => Effect.logWarning("A session callback could not be removed.", cause)),
    );

  const watchOnce = (record: StoredCallback, withinMs: number | undefined) =>
    environments
      .get(record.serverId)
      .pipe(
        Effect.flatMap((environment) =>
          (withinMs === undefined
            ? environment
                .thread(ThreadId.make(record.sessionId))
                .pipe(Effect.map((projection) => ({ projection, settled: false })))
            : environment.waitForThread(
                ThreadId.make(record.sessionId),
                turnEnded(record.runIds),
                withinMs,
              )
          ).pipe(Effect.map((watched) => ({ ...watched, environment }))),
        ),
      );

  const waitForEvent = Effect.fn("SessionCallbacks.waitForEvent")(function* (
    record: StoredCallback,
  ) {
    while (true) {
      const remaining = record.expiresAt - (yield* Clock.currentTimeMillis);
      const expired = remaining <= 0;
      const outcome = yield* watchOnce(
        record,
        expired ? undefined : Math.min(remaining, WATCH_CHUNK_MS),
      ).pipe(Effect.result);
      const base = {
        event: "session.status" as const,
        event_id: record.id,
        server_id: record.serverId,
        session_id: record.sessionId,
        occurred_at: DateTime.formatIso(yield* DateTime.now),
      };
      if (outcome._tag === "Success" && (outcome.success.settled || expired)) {
        const { environment, projection, settled } = outcome.success;
        const status = yield* options.report(environment, projection, {
          cursor: record.cursor,
          timedOut: !settled,
        });
        return { ...base, status } satisfies CallbackEvent;
      }
      if (outcome._tag === "Failure") {
        if (expired) return { ...base, error: outcome.failure.message } satisfies CallbackEvent;
        yield* Effect.logWarning(
          `A session callback could not watch ${record.serverId}; retrying.`,
          outcome.failure.message,
        );
        yield* Effect.sleep(UNREACHABLE_RETRY);
      }
    }
  });

  const post = (record: StoredCallback, event: CallbackEvent) =>
    http
      .execute(
        HttpClientRequest.post(record.url).pipe(
          HttpClientRequest.setHeaders(
            Object.fromEntries(record.headers.map((header) => [header.name, header.value])),
          ),
          HttpClientRequest.bodyJsonUnsafe(event),
        ),
      )
      .pipe(
        Effect.timeout(POST_TIMEOUT),
        Effect.map((response) => ({
          delivery: classify(response.status),
          status: response.status as number | undefined,
          retryAfter: response.headers["retry-after"],
        })),
        Effect.orElseSucceed(() => ({
          delivery: "retry" as const,
          status: undefined,
          retryAfter: undefined,
        })),
      );

  const deliver = Effect.fn("SessionCallbacks.deliver")(function* (
    record: StoredCallback,
    event: CallbackEvent,
  ) {
    const firstAttemptAt = yield* Clock.currentTimeMillis;
    for (let attempt = 0; ; attempt++) {
      const sent = yield* post(record, event);
      if (sent.delivery === "delivered") return;
      if (sent.delivery === "refused") {
        return yield* Effect.logWarning(
          `A session callback was refused with HTTP ${sent.status}; it will not be sent again.`,
        );
      }
      const now = yield* Clock.currentTimeMillis;
      const delay = Math.min(
        MAX_RETRY_DELAY_MS,
        retryAfterMs(sent.retryAfter, now) ??
          RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!,
      );
      if (now + delay - firstAttemptAt > RETRY_WINDOW_MS) {
        return yield* Effect.logWarning("A session callback was not delivered within a day.");
      }
      yield* Effect.sleep(Duration.millis(delay));
    }
  });

  // Removal waits for delivery and is skipped on interruption, so a restart resumes the record.
  const runCallback = Effect.fn("SessionCallbacks.run")(
    function* (record: StoredCallback) {
      let event = record.event;
      if (event === undefined) {
        const ended = yield* waitForEvent(record);
        event = ended;
        yield* update((current) => [
          undefined,
          current.map((stored) => (stored.id === record.id ? { ...stored, event: ended } : stored)),
        ]).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("A session callback result was not saved.", cause),
          ),
        );
      }
      yield* deliver(record, event);
    },
    (effect, record) => effect.pipe(Effect.andThen(remove(record.id))),
  );

  for (const record of initial) {
    yield* FiberMap.run(running, keyOf(record), runCallback(record));
  }

  const saveFailure = (message: string) => () => new BridgeError({ message });

  return SessionCallbacks.of({
    set: Effect.fn("SessionCallbacks.set")(function* (input) {
      const environment = yield* environments.get(input.serverId);
      const projection = yield* environment.thread(ThreadId.make(input.sessionId));
      const key = keyFor(environment.id, projection.thread.id);
      if (input.callback === null) {
        yield* FiberMap.remove(running, key);
        yield* update((current) => [
          undefined,
          current.filter((record) => keyOf(record) !== key),
        ]).pipe(Effect.mapError(saveFailure("The callback could not be removed.")));
        return { environment, projection, armed: null };
      }
      const problem = callbackUrlProblem(input.callback.url);
      if (problem !== undefined) return yield* new BridgeError({ message: problem });
      const record: StoredCallback = {
        id: yield* random
          .uuidV4()
          .pipe(Effect.mapError(saveFailure("Unable to set the callback."))),
        serverId: environment.id,
        sessionId: projection.thread.id,
        url: input.callback.url,
        headers: input.callback.headers ?? [],
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        runIds: workingRunIds(projection),
        expiresAt: (yield* Clock.currentTimeMillis) + CALLBACK_TTL_MS,
      };
      const saved = yield* update((current): readonly [boolean, ReadonlyArray<StoredCallback>] => {
        const others = current.filter((stored) => keyOf(stored) !== key);
        return others.length >= MAX_CALLBACKS ? [false, current] : [true, [...others, record]];
      }).pipe(Effect.mapError(saveFailure("The callback could not be saved.")));
      if (!saved) {
        return yield* new BridgeError({
          message: `The bridge already holds ${MAX_CALLBACKS} callbacks.`,
        });
      }
      yield* FiberMap.run(running, key, runCallback(record));
      return { environment, projection, armed: armedOf(record) };
    }),
    armed: Effect.fn("SessionCallbacks.armed")(function* (serverId, sessionId) {
      const key = keyFor(serverId, sessionId);
      const record = (yield* Ref.get(records)).find((stored) => keyOf(stored) === key);
      return record === undefined ? null : armedOf(record);
    }),
  });
});

export const layer = (options: { readonly dataDir: string; readonly report: StatusReport }) =>
  Layer.effect(SessionCallbacks, make(options)).pipe(Layer.provide(layerCallbackHttp));
