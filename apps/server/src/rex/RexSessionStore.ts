import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

/**
 * What T3 knows about a worktree's Rex session. `rec` in OpenInRex.tla: an intent is written
 * before `rex new` under a label only that click uses, so a restart can find what it created.
 */
export const RexRecord = Schema.Union([
  Schema.Struct({ st: Schema.Literal("intent"), label: Schema.String }),
  Schema.Struct({
    st: Schema.Literal("pending"),
    sessionId: Schema.String,
    holders: Schema.Array(Schema.String),
    // An app has owned the session's size; an owner can drop it again when its Mac sleeps.
    saw: Schema.Boolean,
  }),
  Schema.Struct({ st: Schema.Literal("confirmed"), sessionId: Schema.String }),
]);
export type RexRecord = typeof RexRecord.Type;

export class RexStoreError extends Schema.TaggedError<RexStoreError>()("RexStoreError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Couldn't save the Rex session record";
  }
}

const RexRecordsJson = Schema.fromJsonString(Schema.Record(Schema.String, RexRecord));
const decodeRecords = Schema.decodeUnknownEffect(RexRecordsJson);
const encodeRecords = Schema.encodeEffect(RexRecordsJson);

/** Records by worktree path. A write persists before it returns, or fails and changes nothing. */
export class RexSessionStore extends Context.Service<
  RexSessionStore,
  {
    readonly get: (cwd: string) => Effect.Effect<RexRecord | undefined>;
    readonly set: (
      cwd: string,
      record: RexRecord | undefined,
    ) => Effect.Effect<void, RexStoreError>;
    readonly all: () => Effect.Effect<ReadonlyMap<string, RexRecord>>;
  }
>()("t3/rex/RexSessionStore") {}

const makeWith = Effect.fnUntraced(function* (
  initial: ReadonlyMap<string, RexRecord>,
  persist: (records: ReadonlyMap<string, RexRecord>) => Effect.Effect<void, RexStoreError>,
) {
  const records = yield* Ref.make<ReadonlyMap<string, RexRecord>>(initial);
  // Worktrees write concurrently; the file holds all of them.
  const writeLock = yield* Semaphore.make(1);
  return RexSessionStore.of({
    get: Effect.fn("RexSessionStore.get")(function* (cwd: string) {
      return (yield* Ref.get(records)).get(cwd);
    }),
    set: Effect.fn("RexSessionStore.set")(function* (cwd: string, record: RexRecord | undefined) {
      const next = new Map(yield* Ref.get(records));
      if (record === undefined) next.delete(cwd);
      else next.set(cwd, record);
      yield* persist(next);
      yield* Ref.set(records, next);
    }, writeLock.withPermits(1)),
    all: Effect.fn("RexSessionStore.all")(function* () {
      return yield* Ref.get(records);
    }),
  });
});

export const make = Effect.fn("RexSessionStore.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const file = path.join(stateDir, "rex-sessions.json");

  const initial = yield* fileSystem.readFileString(file).pipe(
    Effect.flatMap(decodeRecords),
    Effect.map((records) => new Map(Object.entries(records))),
    Effect.orElseSucceed(() => new Map<string, RexRecord>()),
  );

  // The rename keeps a crash from leaving half a file.
  const persist = (records: ReadonlyMap<string, RexRecord>) =>
    encodeRecords(Object.fromEntries(records)).pipe(
      Effect.flatMap((text) => fileSystem.writeFileString(`${file}.tmp`, text)),
      Effect.flatMap(() => fileSystem.rename(`${file}.tmp`, file)),
      Effect.mapError((cause) => new RexStoreError({ cause })),
    );

  return yield* makeWith(initial, persist);
});

export const layer = Layer.effect(RexSessionStore, make());

export const layerMemory = (initial: ReadonlyMap<string, RexRecord> = new Map()) =>
  Layer.effect(
    RexSessionStore,
    makeWith(initial, () => Effect.void),
  );
