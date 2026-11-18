import {
  RexOpenError,
  type RexOpenResult,
  type RexReportInput,
  type RexStatus,
} from "@t3tools/contracts/rex";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";

import * as RexCli from "./RexCli.ts";
import * as RexSessionStore from "./RexSessionStore.ts";

/**
 * The session lifecycle of OpenInRex.tla (scripts/self-hosted/rex-open-model), with every design
 * choice on. Each function named after a model action is that action; everything one action does
 * runs under its worktree's lock, so the model's atomic steps stay atomic here.
 */
export interface RexSessionsShape {
  readonly status: () => Effect.Effect<RexStatus>;
  readonly open: (cwd: string) => Effect.Effect<RexOpenResult, RexOpenError>;
  readonly report: (input: RexReportInput) => Effect.Effect<void>;
}

const NOT_SET_UP = "Open in Rex isn't set up on this server";

/** The server provides the real lifecycle; anything built without it has no Rex. */
export const RexSessions = Context.Reference<RexSessionsShape>("t3/rex/RexSessions", {
  defaultValue: () => ({
    status: () => Effect.succeed({ available: false, reason: NOT_SET_UP }),
    open: () => Effect.fail(new RexOpenError({ message: NOT_SET_UP })),
    report: () => Effect.void,
  }),
});

/** How long one click holds a pending session without a report. */
const LeaseDuration = Context.Reference<Duration.Duration>("t3/rex/RexSessions/Lease", {
  defaultValue: () => Duration.seconds(30),
});

type CheckResult =
  | { readonly _tag: "reuse"; readonly sessionId: string }
  | { readonly _tag: "create" };

const sessionLabel = (worktree: string, clickId: string) => `${worktree} t3-${clickId}`.slice(-128);

export const make = Effect.fn("RexSessions.make")(function* () {
  const cli = yield* RexCli.RexCli;
  const store = yield* RexSessionStore.RexSessionStore;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const lease = yield* LeaseDuration;
  const scope = yield* Effect.scope;

  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (cwd: string) => {
    let lock = locks.get(cwd);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(cwd, lock);
    }
    return lock;
  };
  const withLock =
    (cwd: string) =>
    <A, E>(effect: Effect.Effect<A, E>) =>
      lockFor(cwd).withPermits(1)(effect);

  const hostError = (error: { readonly message: string }) =>
    new RexOpenError({ message: error.message });
  const logged = (what: string) => (cause: unknown) =>
    Effect.logWarning(`Open in Rex: ${what}`, { cause });

  const isAlive = (sessionId: string) =>
    cli
      .listSessions()
      .pipe(Effect.map((sessions) => sessions.some((s) => s.sessionId === sessionId)));

  // Timers run outside any request so a lease outlives the click that started it.
  const after = (effect: Effect.Effect<void>) =>
    Effect.sleep(lease).pipe(Effect.andThen(effect), Effect.forkIn(scope), Effect.asVoid);

  /** Reap and KillSession: kill a pending session nobody holds, unless an app took it over. */
  const reapOnce = Effect.fn("RexSessions.reap")(function* (cwd: string) {
    const rec = yield* store.get(cwd);
    if (rec?.st !== "pending" || rec.holders.length > 0) return;
    const outcome = yield* Effect.gen(function* () {
      if (!(yield* isAlive(rec.sessionId))) return undefined;
      if (yield* cli.takenOver(rec.sessionId)) {
        return { st: "confirmed", sessionId: rec.sessionId } as const;
      }
      yield* cli.kill(rec.sessionId);
      return undefined;
    });
    yield* store.set(cwd, outcome);
  });

  // A failed read is never "gone" and never "unowned": try again after another lease.
  const reap = (cwd: string): Effect.Effect<void> =>
    reapOnce(cwd).pipe(
      Effect.catch((cause) =>
        logged("could not reap a pending session")(cause).pipe(
          Effect.andThen(after(withLock(cwd)(reap(cwd)))),
        ),
      ),
    );

  /**
   * Startup's intent branch: the labelled session, if `rex new` made it, becomes pending with no
   * holder, so the size-checked reap decides it.
   */
  const resolveIntent = Effect.fn("RexSessions.resolveIntent")(function* (
    cwd: string,
    label: string,
  ) {
    const found = (yield* cli.listSessions()).find((session) => session.label === label);
    yield* store.set(
      cwd,
      found === undefined ? undefined : { st: "pending", sessionId: found.sessionId, holders: [] },
    );
    yield* reap(cwd);
  });

  const resolveIntentOrRetry = (cwd: string, label: string): Effect.Effect<void> =>
    resolveIntent(cwd, label).pipe(
      Effect.catch((cause) =>
        logged("could not look for a session an earlier request created")(cause).pipe(
          Effect.andThen(after(withLock(cwd)(resolveIntentOrRetry(cwd, label)))),
        ),
      ),
    );

  const leaseEnds = Effect.fn("RexSessions.leaseEnds")(function* (cwd: string, clickId: string) {
    const rec = yield* store.get(cwd);
    if (rec?.st !== "pending" || !rec.holders.includes(clickId)) return;
    yield* store.set(cwd, { ...rec, holders: rec.holders.filter((h) => h !== clickId) });
    yield* reap(cwd);
  });

  const armLease = (cwd: string, clickId: string) =>
    after(
      withLock(cwd)(leaseEnds(cwd, clickId).pipe(Effect.catch(logged("could not end a lease")))),
    );

  const checkRecord = Effect.fn("RexSessions.checkRecord")(function* (cwd: string) {
    let rec = yield* store.get(cwd);
    // The model never sees an intent here; code can, after `rex new` and the lookup both failed.
    if (rec?.st === "intent") {
      yield* resolveIntent(cwd, rec.label);
      rec = yield* store.get(cwd);
    }
    if ((rec?.st === "pending" || rec?.st === "confirmed") && (yield* isAlive(rec.sessionId))) {
      return { _tag: "reuse", sessionId: rec.sessionId } satisfies CheckResult as CheckResult;
    }
    return { _tag: "create" } satisfies CheckResult as CheckResult;
  });

  const reuse = Effect.fn("RexSessions.reuse")(function* (
    cwd: string,
    clickId: string,
    sessionId: string,
  ) {
    const rec = yield* store.get(cwd);
    if (rec?.st === "pending" && rec.sessionId === sessionId) {
      yield* store.set(cwd, { ...rec, holders: [...rec.holders, clickId] });
      yield* armLease(cwd, clickId);
    }
    return sessionId;
  });

  const writeIntent = (cwd: string, label: string) => store.set(cwd, { st: "intent", label });

  const rexNew = (cwd: string, label: string) =>
    cli.create(label, cwd).pipe(Effect.tapError(() => resolveIntentOrRetry(cwd, label)));

  const recordPending = Effect.fn("RexSessions.recordPending")(function* (
    cwd: string,
    clickId: string,
    sessionId: string,
  ) {
    yield* store.set(cwd, { st: "pending", sessionId, holders: [clickId] });
    yield* armLease(cwd, clickId);
    return sessionId;
  });

  const receiveOpen = Effect.fn("RexSessions.receiveOpen")(function* (
    cwd: string,
    clickId: string,
  ) {
    const check = yield* checkRecord(cwd);
    if (check._tag === "reuse") return yield* reuse(cwd, clickId, check.sessionId);
    const label = sessionLabel(path.basename(cwd), clickId);
    yield* writeIntent(cwd, label);
    const sessionId = yield* rexNew(cwd, label);
    return yield* recordPending(cwd, clickId, sessionId);
  });

  const receiveConfirm = Effect.fn("RexSessions.receiveConfirm")(function* (
    cwd: string,
    sessionId: string,
  ) {
    const rec = yield* store.get(cwd);
    if (rec?.st === "pending" && rec.sessionId === sessionId) {
      yield* store.set(cwd, { st: "confirmed", sessionId });
    }
  });

  const receiveAbandon = Effect.fn("RexSessions.receiveAbandon")(function* (
    cwd: string,
    clickId: string,
    sessionId: string,
  ) {
    const rec = yield* store.get(cwd);
    if (rec?.st !== "pending" || rec.sessionId !== sessionId) return;
    yield* store.set(cwd, { ...rec, holders: rec.holders.filter((h) => h !== clickId) });
    yield* reap(cwd);
  });

  /** Pending sessions get a fresh lease per holder instead of a kill; intents are looked up. */
  const startup = Effect.fn("RexSessions.startup")(function* (
    cwd: string,
    rec: RexSessionStore.RexRecord,
  ) {
    if (rec.st === "intent") return yield* resolveIntentOrRetry(cwd, rec.label);
    if (rec.st !== "pending") return;
    for (const holder of rec.holders) yield* armLease(cwd, holder);
    if (rec.holders.length === 0) yield* reap(cwd);
  });

  // Each recorded worktree is locked before any request can reach it and unlocked once its
  // startup is done; worktrees without a record take requests at once.
  for (const [cwd, rec] of yield* store.all()) {
    const lock = lockFor(cwd);
    yield* lock.take(1);
    yield* startup(cwd, rec).pipe(Effect.ensuring(lock.release(1)), Effect.forkIn(scope));
  }

  const open = Effect.fn("RexSessions.open")(function* (cwd: string) {
    const status = yield* cli.status();
    if (!status.available) return yield* new RexOpenError({ message: status.reason });
    // `rex new` starts a session even in a folder that doesn't exist.
    const isFolder = yield* fileSystem.stat(cwd).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (!isFolder)
      return yield* new RexOpenError({ message: `${cwd} isn't a folder on this host` });
    const clickId = (yield* Random.nextIntBetween(0, 0xffffffff)).toString(16).padStart(8, "0");
    const sessionId = yield* withLock(cwd)(receiveOpen(cwd, clickId)).pipe(
      Effect.mapError(hostError),
    );
    return { clickId, sessionId, hostId: status.hostId };
  });

  const report = (input: RexReportInput) =>
    withLock(input.cwd)(
      input.outcome === "confirm"
        ? receiveConfirm(input.cwd, input.sessionId)
        : receiveAbandon(input.cwd, input.clickId, input.sessionId),
    ).pipe(Effect.catch(logged(`could not record ${input.outcome}`)));

  return { status: cli.status, open, report } satisfies RexSessionsShape;
});

export const layer = Layer.effect(RexSessions, make()).pipe(
  Layer.provide(Layer.mergeAll(RexCli.layer, RexSessionStore.layer)),
);
