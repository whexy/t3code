import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ClientOrchestrationCommand, OrchestrationThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BridgeError, Environments, type T3Environment } from "./environment.ts";
import { summarizeSession } from "./status.ts";
import { activity, at, message, NOW, thread } from "./testing.ts";
import { BridgeToolkit, BridgeToolkitHandlersLive } from "./tools.ts";

/** A bridge paired with one server that holds `session` and records turn starts. */
function bridgeWith(
  session: OrchestrationThread,
  options: { snapshots?: OrchestrationThread[]; interruptError?: BridgeError } = {},
) {
  let reads = 0;
  const sent: Array<ClientOrchestrationCommand> = [];
  const environment: T3Environment = {
    id: "home",
    name: "Home",
    expiresAt: "2026-10-28T12:00:00.000Z",
    shell: Effect.die("unused"),
    dispatchCommand: () => Effect.die("unused"),
    createRef: () => Effect.die("unused"),
    switchRef: () => Effect.die("unused"),
    listRefs: () => Effect.die("unused"),
    usageSummary: () => Effect.die("unused"),
    serverConfig: Effect.die("unused"),
    thread: (threadId) =>
      threadId === session.id
        ? Effect.sync(() => ({
            snapshotSequence: 1,
            thread: options.snapshots?.[reads++] ?? session,
          }))
        : Effect.fail(new BridgeError({ message: `Session ${threadId} was not found.` })),
    createProject: () => Effect.die("unused"),
    cloneProject: () => Effect.die("unused"),
    waitForThread: () => Effect.never,
    interruptTurn: (command) =>
      options.interruptError
        ? Effect.fail(options.interruptError)
        : Effect.sync(() => {
            sent.push(command);
            return { sequence: sent.length };
          }),
    startTurn: (command) =>
      Effect.sync(() => {
        sent.push(command);
        return { sequence: sent.length };
      }),
  };
  const handlers = BridgeToolkitHandlersLive.pipe(
    Layer.provide(
      Layer.succeed(
        Environments,
        Environments.of({
          enabled: Effect.succeed([environment]),
          get: () => Effect.succeed(environment),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const sendMessage = (message: string, mode?: "queue" | "steer" | null) =>
    Effect.gen(function* () {
      const toolkit = yield* BridgeToolkit;
      const results = yield* toolkit
        .handle("send_session_message", {
          server_id: "home",
          session_id: session.id,
          message,
          ...(mode === undefined ? {} : { mode }),
        })
        .pipe(Effect.flatMap(Stream.runCollect));
      const { result } = results[0]!;
      // A tool failure fails the stream, so anything else here is unexpected.
      return "delivery" in result ? result : yield* Effect.die(result);
    }).pipe(Effect.provide(handlers));
  const interrupt = Effect.gen(function* () {
    const toolkit = yield* BridgeToolkit;
    const results = yield* toolkit
      .handle("interrupt_session", { server_id: "home", session_id: session.id })
      .pipe(Effect.flatMap(Stream.runCollect));
    const { result } = results[0]!;
    return "cancelled_message_ids" in result ? result : yield* Effect.die(result);
  }).pipe(Effect.provide(handlers));
  return { sent, sendMessage, interrupt, handlers };
}

const completed = thread({
  latestTurn: { ...thread().latestTurn!, state: "completed", completedAt: at(20) },
  session: { ...thread().session!, status: "ready", activeTurnId: null },
  messages: [...thread().messages, message("reply", "assistant", "Fixed the retry loop", 20)],
});

describe("send_session_message", () => {
  it.effect("continues the session's own thread, as a new turn or into the running one", () =>
    Effect.gen(function* () {
      const finished = bridgeWith(completed);
      const sent = yield* finished.sendMessage("Also update the docs");
      expect(sent).toMatchObject({ session_id: completed.id, delivery: "new_turn" });
      // The returned cursor makes the next status report the follow-up, not the earlier turn.
      const followedUp = thread({
        ...completed,
        messages: [...completed.messages, message("follow-up", "user", "Also update the docs", 25)],
      });
      expect(
        summarizeSession(followedUp, { cursor: sent.cursor, limit: 10, now: NOW }).updates.map(
          (update) => update.text,
        ),
      ).toEqual(["Also update the docs"]);
      const [command] = finished.sent;
      expect(command).toMatchObject({
        type: "thread.turn.start",
        threadId: completed.id,
        message: { role: "user", text: "Also update the docs" },
        runtimeMode: completed.runtimeMode,
        interactionMode: completed.interactionMode,
      });
      // A bootstrap would create another thread; a model selection would switch agents.
      expect(command).not.toHaveProperty("bootstrap");
      expect(command).not.toHaveProperty("modelSelection");

      const running = bridgeWith(thread());
      expect(yield* running.sendMessage("Skip the e2e suite")).toMatchObject({
        delivery: "during_turn",
      });
      expect(running.sent).toHaveLength(1);
    }),
  );

  it.effect("refuses while the agent waits for an approval, sending nothing", () =>
    Effect.gen(function* () {
      const waiting = bridgeWith(
        thread({
          activities: [
            activity(
              "ask",
              "approval.requested",
              3,
              { requestId: "request-1", requestKind: "command", detail: "rm -rf build" },
              { tone: "approval" },
            ),
          ],
        }),
      );
      const error = yield* Effect.flip(waiting.sendMessage("Go ahead"));
      expect(error.message).toContain("waiting for an approval or an answer");
      expect(waiting.sent).toEqual([]);
    }),
  );
});

describe("explicit message modes", () => {
  it.effect("steers immediately and retains the legacy null default", () =>
    Effect.gen(function* () {
      const active = bridgeWith(thread());
      expect(yield* active.sendMessage("Change direction", "steer")).toMatchObject({
        delivery: "steered",
        message_id: expect.any(String),
      });
      expect(yield* active.sendMessage("Keep going", null)).toMatchObject({
        delivery: "during_turn",
      });
      expect(active.sent).toHaveLength(2);
    }),
  );

  it.effect("both modes start a new turn for settled sessions", () =>
    Effect.gen(function* () {
      for (const state of ["completed", "interrupted", "error"] as const) {
        const settled = { ...completed, latestTurn: { ...completed.latestTurn!, state } };
        for (const mode of ["queue", "steer"] as const) {
          const bridge = bridgeWith(settled);
          expect(yield* bridge.sendMessage("Continue", mode)).toMatchObject({
            delivery: "new_turn",
          });
          expect(bridge.sent).toHaveLength(1);
        }
      }
      const idle = bridgeWith(thread({ latestTurn: null, session: null, messages: [] }));
      expect(yield* idle.sendMessage("Start", "queue")).toMatchObject({ delivery: "new_turn" });
    }),
  );

  it.effect("reports structured refusal for steering over a question", () =>
    Effect.gen(function* () {
      const bridge = bridgeWith(
        thread({
          activities: [
            activity("ask", "user-input.requested", 3, {
              requestId: "question-1",
              questions: [{ id: "q", header: "Choice", question: "Which?", options: [] }],
            }),
          ],
        }),
      );
      expect(yield* Effect.flip(bridge.sendMessage("Yes", "steer"))).toMatchObject({
        code: "message_not_applicable",
        state: "waiting",
      });
      expect(bridge.sent).toEqual([]);
    }),
  );
});

describe("interrupt_session", () => {
  it.effect(
    "uses the UI interrupt command, without deleting the thread or claiming settlement",
    () =>
      Effect.gen(function* () {
        const bridge = bridgeWith(thread());
        expect(yield* bridge.interrupt).toMatchObject({
          result: "interrupt_requested",
          state: "running",
          cancelled_message_ids: [],
        });
        expect(bridge.sent).toHaveLength(1);
        expect(bridge.sent[0]).toMatchObject({
          type: "thread.turn.interrupt",
          threadId: thread().id,
          turnId: thread().session!.activeTurnId,
        });
      }),
  );

  it.effect("allows Stop while waiting for approval or input", () =>
    Effect.gen(function* () {
      for (const kind of ["approval.requested", "user-input.requested"]) {
        const bridge = bridgeWith(
          thread({
            activities: [
              activity("ask", kind, 3, {
                requestId: "request-1",
                requestKind: "command",
                questions: [{ id: "q", header: "Choice", question: "Which?", options: [] }],
              }),
            ],
          }),
        );
        expect(yield* bridge.interrupt).toMatchObject({ result: "interrupt_requested" });
        expect(bridge.sent[0]?.type).toBe("thread.turn.interrupt");
      }
    }),
  );

  it.effect("handles idle sessions and completion races without issuing Stop", () =>
    Effect.gen(function* () {
      const bridge = bridgeWith(thread(), { snapshots: [thread(), completed] });
      expect(yield* bridge.interrupt).toMatchObject({
        result: "already_inactive",
        state: "completed",
      });
      expect(bridge.sent).toEqual([]);
      const idle = bridgeWith(thread({ latestTurn: null, session: null, messages: [] }));
      expect(yield* idle.interrupt).toMatchObject({ result: "already_inactive", state: "idle" });
    }),
  );

  it.effect("does not stop a newly observed replacement turn", () =>
    Effect.gen(function* () {
      const replacement = thread({ session: { ...thread().session!, activeTurnId: null } });
      const bridge = bridgeWith(thread(), { snapshots: [thread(), replacement] });
      expect(yield* bridge.interrupt).toMatchObject({ result: "turn_changed" });
      expect(bridge.sent).toEqual([]);
    }),
  );

  it.effect("does not stop work that starts after an inactive observation", () =>
    Effect.gen(function* () {
      const bridge = bridgeWith(completed, { snapshots: [completed, thread()] });
      expect(yield* bridge.interrupt).toMatchObject({ result: "turn_changed", state: "running" });
      expect(bridge.sent).toEqual([]);
    }),
  );

  it.effect("rejects startup states and propagates command rejection", () =>
    Effect.gen(function* () {
      const starting = bridgeWith(
        thread({ session: { ...thread().session!, status: "starting" } }),
      );
      expect(yield* Effect.flip(starting.interrupt)).toMatchObject({
        code: "interrupt_not_applicable",
        state: "starting",
      });
      expect(starting.sent).toEqual([]);
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const queued = bridgeWith(
        thread({
          session: null,
          latestTurn: null,
          messages: [
            message("pending", "user", "Starting", 1, {
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          ],
        }),
      );
      expect(yield* Effect.flip(queued.interrupt)).toMatchObject({
        code: "interrupt_not_applicable",
        state: "queued",
      });
      expect(queued.sent).toEqual([]);
      const rejected = bridgeWith(thread(), {
        interruptError: new BridgeError({ message: "Server refused Stop" }),
      });
      expect((yield* Effect.flip(rejected.interrupt)).message).toBe("Server refused Stop");
    }),
  );

  it.effect("returns the state observed after acceptance", () =>
    Effect.gen(function* () {
      const interrupted = {
        ...completed,
        latestTurn: { ...completed.latestTurn!, state: "interrupted" as const },
      };
      const bridge = bridgeWith(thread(), { snapshots: [thread(), thread(), interrupted] });
      expect(yield* bridge.interrupt).toMatchObject({
        result: "interrupt_requested",
        state: "interrupted",
      });
    }),
  );
});

it.effect("keeps an MCP queued message visible across calls and cancels it through Stop", () => {
  const bridge = bridgeWith(thread());
  return Effect.gen(function* () {
    const toolkit = yield* BridgeToolkit;
    const sent = yield* toolkit
      .handle("send_session_message", {
        server_id: "home",
        session_id: thread().id,
        message: "After the tool",
        mode: "queue",
      })
      .pipe(Effect.flatMap(Stream.runCollect));
    expect(sent[0]!.result).toMatchObject({ delivery: "queued", message_id: expect.any(String) });
    expect(bridge.sent).toEqual([]);
    const status = yield* toolkit
      .handle("get_session_status", {
        server_id: "home",
        session_id: thread().id,
      })
      .pipe(Effect.flatMap(Stream.runCollect));
    expect(status[0]!.result).toMatchObject({ queued_messages: [{ state: "queued" }] });
    const stopped = yield* toolkit
      .handle("interrupt_session", {
        server_id: "home",
        session_id: thread().id,
      })
      .pipe(Effect.flatMap(Stream.runCollect));
    expect(stopped[0]!.result).toMatchObject({
      result: "interrupt_requested",
      cancelled_message_ids: [expect.any(String)],
    });
    expect(bridge.sent.map((command) => command.type)).toEqual(["thread.turn.interrupt"]);
  }).pipe(Effect.provide(bridge.handlers));
});
