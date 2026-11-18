import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as RexCli from "./RexCli.ts";
import * as RexSessionStore from "./RexSessionStore.ts";
import * as RexSessions from "./RexSessions.ts";

const CWD = "/work/t3code";
const MISSING = "/work/missing";

interface FakeSession {
  readonly label: string;
  takenOver: boolean;
}

/** A host Rex server: sessions by id, plus switches for the failures the lifecycle must survive. */
const makeFakeRex = () => {
  const sessions = new Map<string, FakeSession>();
  const killed: Array<string> = [];
  const state = { next: 1, listFails: false, createFails: false, created: 0 };
  const failure = (operation: string) =>
    new RexCli.RexCliError({ operation, message: "rex server is not running" });
  const cli = RexCli.RexCli.of({
    status: () => Effect.succeed({ available: true, hostId: "host-mudd" }),
    listSessions: () =>
      state.listFails
        ? Effect.fail(failure("ls"))
        : Effect.succeed([...sessions].map(([sessionId, s]) => ({ sessionId, label: s.label }))),
    create: (label) =>
      Effect.gen(function* () {
        // Lets a second click's request interleave here, as a real `rex new` would.
        yield* Effect.yieldNow;
        if (state.createFails) return yield* failure("new");
        const sessionId = `session:${state.next++}`;
        sessions.set(sessionId, { label, takenOver: false });
        state.created++;
        return sessionId;
      }),
    takenOver: (sessionId) => Effect.succeed(sessions.get(sessionId)?.takenOver ?? false),
    kill: (sessionId) =>
      Effect.sync(() => {
        sessions.delete(sessionId);
        killed.push(sessionId);
      }),
  });
  return { sessions, killed, state, cli };
};

const setup = (initial: ReadonlyMap<string, RexSessionStore.RexRecord> = new Map()) => {
  const rex = makeFakeRex();
  const store = Layer.fresh(RexSessionStore.layerMemory(initial));
  const sessions = Layer.effect(RexSessions.RexSessions, RexSessions.make()).pipe(
    Layer.provideMerge(store),
    Layer.provide(Layer.succeed(RexCli.RexCli, rex.cli)),
    // Every worktree is a folder except MISSING.
    Layer.provide(
      FileSystem.layerNoop({
        stat: (path) =>
          Effect.succeed({ type: path === MISSING ? "File" : "Directory" } as FileSystem.File.Info),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { rex, layer: sessions };
};

const record = Effect.fn(function* (cwd = CWD) {
  const store = yield* RexSessionStore.RexSessionStore;
  return yield* store.get(cwd);
});

it.effect(
  "a second click joins a pending session; it dies only when neither click holds it",
  () => {
    const { rex, layer } = setup();
    return Effect.gen(function* () {
      const rexSessions = yield* RexSessions.RexSessions;
      const first = yield* rexSessions.open(CWD);
      yield* TestClock.adjust("20 seconds");
      const second = yield* rexSessions.open(CWD);
      assert.strictEqual(second.sessionId, first.sessionId);
      assert.strictEqual(rex.state.created, 1);

      yield* rexSessions.report({ cwd: CWD, ...first, outcome: "abandon" });
      assert.deepStrictEqual(rex.killed, []);
      // The first click's lease ends; the second click's lease still holds the session.
      yield* TestClock.adjust("15 seconds");
      assert.deepStrictEqual(rex.killed, []);

      yield* TestClock.adjust("15 seconds");
      assert.deepStrictEqual(rex.killed, [first.sessionId]);
      assert.strictEqual(yield* record(), undefined);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a confirmed session is kept and reused without a lease", () => {
  const { rex, layer } = setup();
  return Effect.gen(function* () {
    const rexSessions = yield* RexSessions.RexSessions;
    const opened = yield* rexSessions.open(CWD);
    yield* rexSessions.report({ cwd: CWD, ...opened, outcome: "confirm" });
    yield* TestClock.adjust("1 minute");
    const again = yield* rexSessions.open(CWD);
    yield* TestClock.adjust("1 minute");

    assert.strictEqual(again.sessionId, opened.sessionId);
    assert.deepStrictEqual(rex.killed, []);
    assert.deepStrictEqual(yield* record(), { st: "confirmed", sessionId: opened.sessionId });
  }).pipe(Effect.provide(layer));
});

it.effect("a lease that ends without a report kills the session unless an app owns it", () => {
  const { rex, layer } = setup();
  return Effect.gen(function* () {
    const rexSessions = yield* RexSessions.RexSessions;
    const lost = yield* rexSessions.open(CWD);
    yield* TestClock.adjust("30 seconds");
    assert.deepStrictEqual(rex.killed, [lost.sessionId]);

    const shown = yield* rexSessions.open(CWD);
    rex.sessions.get(shown.sessionId)!.takenOver = true;
    yield* rexSessions.report({ cwd: CWD, ...shown, outcome: "abandon" });
    assert.deepStrictEqual(rex.killed, [lost.sessionId]);
    assert.deepStrictEqual(yield* record(), { st: "confirmed", sessionId: shown.sessionId });
  }).pipe(Effect.provide(layer));
});

it.effect("an app that owned the size once keeps the session after its Mac drops off", () => {
  const { rex, layer } = setup();
  return Effect.gen(function* () {
    const rexSessions = yield* RexSessions.RexSessions;
    // The confirm is lost: no report ever arrives.
    const opened = yield* rexSessions.open(CWD);
    rex.sessions.get(opened.sessionId)!.takenOver = true;
    yield* TestClock.adjust("1 second");
    // The Mac sleeps and its app disconnects, which drops the owner.
    rex.sessions.get(opened.sessionId)!.takenOver = false;
    yield* TestClock.adjust("30 seconds");
    assert.deepStrictEqual(rex.killed, []);
    assert.deepStrictEqual(yield* record(), { st: "confirmed", sessionId: opened.sessionId });
  }).pipe(Effect.provide(layer));
});

it.effect("the latch survives a restart", () => {
  const before = setup();
  return Effect.gen(function* () {
    const [opened, persisted] = yield* Effect.gen(function* () {
      const rexSessions = yield* RexSessions.RexSessions;
      const opened = yield* rexSessions.open(CWD);
      before.rex.sessions.get(opened.sessionId)!.takenOver = true;
      yield* TestClock.adjust("1 second");
      return [opened, yield* record()] as const;
    }).pipe(Effect.provide(before.layer));
    assert.deepStrictEqual(persisted, {
      st: "pending",
      sessionId: opened.sessionId,
      holders: [opened.clickId],
      saw: true,
    });

    // The restarted server finds the record as it was persisted, with the owner gone.
    const after = setup(new Map([[CWD, persisted!]]));
    after.rex.sessions.set(opened.sessionId, { label: "t3code", takenOver: false });
    yield* Effect.gen(function* () {
      yield* RexSessions.RexSessions;
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(after.rex.killed, []);
      assert.deepStrictEqual(yield* record(), { st: "confirmed", sessionId: opened.sessionId });
    }).pipe(Effect.provide(after.layer));
  });
});

it.effect("a session the user closed is replaced, not handed out", () => {
  const { rex, layer } = setup();
  return Effect.gen(function* () {
    const rexSessions = yield* RexSessions.RexSessions;
    const opened = yield* rexSessions.open(CWD);
    yield* rexSessions.report({ cwd: CWD, ...opened, outcome: "confirm" });
    rex.sessions.delete(opened.sessionId);
    const next = yield* rexSessions.open(CWD);
    assert.notStrictEqual(next.sessionId, opened.sessionId);
    assert.strictEqual(rex.state.created, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("a failed session list fails the click instead of counting the session as gone", () => {
  const { rex, layer } = setup();
  return Effect.gen(function* () {
    const rexSessions = yield* RexSessions.RexSessions;
    const opened = yield* rexSessions.open(CWD);
    yield* rexSessions.report({ cwd: CWD, ...opened, outcome: "confirm" });
    rex.state.listFails = true;
    const exit = yield* Effect.exit(rexSessions.open(CWD));
    assert.isTrue(Exit.isFailure(exit));
    assert.strictEqual(rex.state.created, 1);
    assert.deepStrictEqual(yield* record(), { st: "confirmed", sessionId: opened.sessionId });
  }).pipe(Effect.provide(layer));
});

it.effect("a failed reap retries after another lease instead of killing blind", () => {
  const { rex, layer } = setup();
  return Effect.gen(function* () {
    const rexSessions = yield* RexSessions.RexSessions;
    const opened = yield* rexSessions.open(CWD);
    rex.state.listFails = true;
    yield* TestClock.adjust("30 seconds");
    assert.deepStrictEqual(rex.killed, []);
    rex.state.listFails = false;
    yield* TestClock.adjust("30 seconds");
    assert.deepStrictEqual(rex.killed, [opened.sessionId]);
  }).pipe(Effect.provide(layer));
});

it.effect("clicks on one worktree are serialized into one session", () => {
  const { rex, layer } = setup();
  return Effect.gen(function* () {
    const rexSessions = yield* RexSessions.RexSessions;
    const [a, b] = yield* Effect.all([rexSessions.open(CWD), rexSessions.open(CWD)], {
      concurrency: "unbounded",
    });
    assert.strictEqual(a.sessionId, b.sessionId);
    assert.strictEqual(rex.state.created, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("a host-side failure carries Rex's message and leaves no record", () => {
  const { rex, layer } = setup();
  return Effect.gen(function* () {
    const rexSessions = yield* RexSessions.RexSessions;
    rex.state.createFails = true;
    const error = yield* Effect.flip(rexSessions.open(CWD));
    assert.strictEqual(error.message, "rex server is not running");
    assert.strictEqual(yield* record(), undefined);
  }).pipe(Effect.provide(layer));
});

it.effect("a path that isn't a folder on the host fails the click before Rex runs", () => {
  const { rex, layer } = setup();
  return Effect.gen(function* () {
    const rexSessions = yield* RexSessions.RexSessions;
    const error = yield* Effect.flip(rexSessions.open(MISSING));
    assert.strictEqual(error.message, `${MISSING} isn't a folder on this host`);
    assert.strictEqual(rex.state.created, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("startup gives each pending holder a fresh lease instead of killing", () => {
  const { rex, layer } = setup(
    new Map([[CWD, { st: "pending", sessionId: "session:9", holders: ["click-a"], saw: false }]]),
  );
  rex.sessions.set("session:9", { label: "t3code t3-click-a", takenOver: false });
  return Effect.gen(function* () {
    yield* RexSessions.RexSessions;
    yield* TestClock.adjust("29 seconds");
    assert.deepStrictEqual(rex.killed, []);
    yield* TestClock.adjust("1 second");
    assert.deepStrictEqual(rex.killed, ["session:9"]);
  }).pipe(Effect.provide(layer));
});

it.effect("startup turns an intent's session into an unheld pending one and size-checks it", () => {
  const OTHER = "/work/other";
  const { rex, layer } = setup(
    new Map<string, RexSessionStore.RexRecord>([
      [CWD, { st: "intent", label: "t3code t3-click-a" }],
      [OTHER, { st: "intent", label: "other t3-click-b" }],
      ["/work/gone", { st: "intent", label: "gone t3-click-c" }],
    ]),
  );
  rex.sessions.set("session:7", { label: "t3code t3-click-a", takenOver: false });
  rex.sessions.set("session:8", { label: "other t3-click-b", takenOver: true });
  return Effect.gen(function* () {
    const rexSessions = yield* RexSessions.RexSessions;
    // A request waits for its worktree's startup.
    yield* rexSessions.status();
    yield* record(CWD);
    yield* rexSessions.report({ cwd: CWD, clickId: "x", sessionId: "x", outcome: "confirm" });
    assert.deepStrictEqual(rex.killed, ["session:7"]);
    assert.strictEqual(yield* record(CWD), undefined);
    yield* rexSessions.report({ cwd: OTHER, clickId: "x", sessionId: "x", outcome: "confirm" });
    assert.deepStrictEqual(yield* record(OTHER), { st: "confirmed", sessionId: "session:8" });
    yield* rexSessions.report({
      cwd: "/work/gone",
      clickId: "x",
      sessionId: "x",
      outcome: "confirm",
    });
    assert.strictEqual(yield* record("/work/gone"), undefined);
  }).pipe(Effect.provide(layer));
});

it.effect("the record survives a restart through its file", () =>
  Effect.gen(function* () {
    const first = yield* RexSessionStore.make();
    yield* first.set(CWD, {
      st: "pending",
      sessionId: "session:1",
      holders: ["click-a"],
      saw: true,
    });
    const second = yield* RexSessionStore.make();
    assert.deepStrictEqual(yield* second.get(CWD), {
      st: "pending",
      sessionId: "session:1",
      holders: ["click-a"],
      saw: true,
    });
  }).pipe(
    Effect.provide(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-rex-store-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
