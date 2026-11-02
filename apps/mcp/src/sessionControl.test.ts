import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { BridgeError } from "./environment.ts";
import { summarizeSession } from "./status.ts";
import {
  approvalItem,
  at,
  callTool,
  completed,
  message,
  projection,
  run,
  runtimeRequest,
  threadId,
  threadServer,
  userMessage,
} from "./testing.ts";

const running = projection();
const waitingForApproval = projection({
  items: [userMessage("user-1", "Fix the flaky test", 1), approvalItem("request-1", 3)],
  runtimeRequests: [runtimeRequest("request-1", "command")],
});

/**
 * How the server routes a dispatched message: into the active run, behind it
 * as a queued run, or as a new run that starts.
 */
const route =
  (outcome: "joined" | "queued" | "started") =>
  (command: OrchestrationV2Command, current: OrchestrationV2ThreadProjection) => {
    if (command.type !== "message.dispatch") return;
    const newRun = run({
      id: RunId.make("run-2"),
      ordinal: 2,
      userMessageId: command.messageId,
      status: outcome === "queued" ? "queued" : "starting",
      startedAt: null,
    });
    return [
      {
        ...current,
        runs: outcome === "joined" ? current.runs : [...current.runs, newRun],
        messages: [
          ...current.messages,
          message(command.messageId, command.text, 25, {
            createdBy: command.createdBy,
            creationSource: command.creationSource,
          }),
        ],
      },
    ];
  };

const send = (message: string, mode?: "queue" | "steer" | null) =>
  callTool("send_session_message", {
    server_id: "home",
    session_id: threadId,
    message,
    ...(mode === undefined ? {} : { mode }),
  });

const control = (
  action: "stop" | "resume_queue" | "drop_queued",
  messageIds?: ReadonlyArray<string>,
) =>
  callTool("control_session", {
    server_id: "home",
    session_id: threadId,
    action,
    ...(messageIds === undefined ? {} : { message_ids: messageIds }),
  });
const stop = control("stop");

describe("send_session_message", () => {
  it.effect("continues the session's own thread as a new turn, keeping its agent and model", () => {
    const server = threadServer(completed, route("started"));
    return Effect.gen(function* () {
      const sent = yield* send("Also update the docs");
      expect(sent).toMatchObject({ session_id: threadId, delivery: "new_turn" });
      const [command] = server.sent;
      expect(command).toEqual({
        type: "message.dispatch",
        commandId: expect.any(String),
        createdBy: "user",
        creationSource: "mcp",
        threadId,
        messageId: sent.message_id,
        text: "Also update the docs",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "auto",
      });
      // The returned cursor makes the next status report the follow-up, not the earlier turn.
      const followedUp = projection({
        runs: completed.runs,
        items: [...completed.turnItems, userMessage(sent.message_id, "Also update the docs", 25)],
      });
      expect(
        summarizeSession(followedUp, { cursor: sent.cursor, limit: 10 }).updates.map(
          (update) => update.text,
        ),
      ).toEqual(["Also update the docs"]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reports where the server routed a message sent during a running turn", () =>
    Effect.gen(function* () {
      for (const [outcome, mode, delivery] of [
        ["joined", null, "during_turn"],
        ["queued", null, "queued"],
        ["joined", "steer", "steered"],
        ["queued", "queue", "queued"],
      ] as const) {
        const server = threadServer(running, route(outcome));
        expect(
          yield* send("Skip the e2e suite", mode).pipe(Effect.provide(server.layer)),
        ).toMatchObject({ delivery });
        expect(server.sent).toHaveLength(1);
      }
    }),
  );

  it.effect("asks the server to steer, or to queue behind the active turn, as requested", () =>
    Effect.gen(function* () {
      const steering = threadServer(running, route("joined"));
      yield* send("Change direction", "steer").pipe(Effect.provide(steering.layer));
      expect(steering.sent[0]).toMatchObject({
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "steer",
      });
      const queueing = threadServer(running, route("queued"));
      yield* send("After this turn", "queue").pipe(Effect.provide(queueing.layer));
      expect(queueing.sent[0]).toMatchObject({ dispatchMode: { type: "queue_after_active" } });
      expect(queueing.sent[0]).not.toHaveProperty("deliveryIntent");
    }),
  );

  it.effect("both modes start a new turn for settled sessions", () =>
    Effect.gen(function* () {
      for (const status of ["completed", "interrupted", "failed"] as const) {
        const settled = { ...completed, runs: [run({ status, completedAt: completed.updatedAt })] };
        for (const mode of ["queue", "steer"] as const) {
          const server = threadServer(settled, route("started"));
          expect(yield* send("Continue", mode).pipe(Effect.provide(server.layer))).toMatchObject({
            delivery: "new_turn",
          });
        }
      }
    }),
  );

  it.effect("refuses to steer over a pending request, sending nothing, but queues behind it", () =>
    Effect.gen(function* () {
      for (const mode of [undefined, null, "steer"] as const) {
        const server = threadServer(waitingForApproval, route("joined"));
        const error = yield* Effect.flip(send("Go ahead", mode).pipe(Effect.provide(server.layer)));
        expect(error).toMatchObject({ code: "message_not_applicable", state: "waiting" });
        expect(error.message).toContain("waiting for an approval or an answer");
        expect(server.sent).toEqual([]);
      }
      const server = threadServer(waitingForApproval, route("queued"));
      expect(yield* send("Then this", "queue").pipe(Effect.provide(server.layer))).toMatchObject({
        delivery: "queued",
      });
    }),
  );

  it.effect("reports the server's rejection", () => {
    const server = threadServer(running, undefined, {
      dispatch: () =>
        Effect.fail(new BridgeError({ message: "codex cannot satisfy message dispatch mode." })),
    });
    return Effect.gen(function* () {
      expect((yield* Effect.flip(send("Change", "steer"))).message).toContain("cannot satisfy");
    }).pipe(Effect.provide(server.layer));
  });
});

/** Run 2 queued by this bridge and run 3 queued in T3 Code, both behind the running run 1. */
const withQueue = projection({
  runs: [
    run(),
    run({
      id: RunId.make("run-2"),
      ordinal: 2,
      userMessageId: MessageId.make("from-bridge"),
      status: "queued",
      startedAt: null,
    }),
    run({
      id: RunId.make("run-3"),
      ordinal: 3,
      userMessageId: MessageId.make("from-web"),
      status: "queued",
      startedAt: null,
    }),
  ],
  messages: [
    message("user-1", "Fix the flaky test", 1),
    message("from-bridge", "Then the docs", 5, { creationSource: "mcp" }),
    message("from-web", "Then the changelog", 6),
  ],
});

/** The same queue after a Stop: run 1 interrupted, both queued runs held. */
const held = {
  ...withQueue,
  runs: withQueue.runs.map((candidate) =>
    candidate.status === "queued"
      ? { ...candidate, queueHeld: true }
      : { ...candidate, status: "interrupted" as const },
  ),
};

const stopped = {
  ...completed,
  runs: [run({ status: "interrupted", completedAt: DateTime.makeUnsafe(at(21)) })],
};

/** How the server applies queue commands to the thread it holds. */
const queueServer = (command: OrchestrationV2Command, current: OrchestrationV2ThreadProjection) => {
  switch (command.type) {
    case "run.interrupt":
      return [held];
    case "queue.resume":
      return [
        {
          ...current,
          runs: current.runs.map((candidate) => ({ ...candidate, queueHeld: false })),
        },
      ];
    case "queued-run.cancel":
      return [
        {
          ...current,
          runs: current.runs.map((candidate) =>
            candidate.id === command.runId
              ? { ...candidate, status: "cancelled" as const }
              : candidate,
          ),
        },
      ];
    default:
      return undefined;
  }
};

describe("control_session stop", () => {
  it.effect(
    "stops the active run as the UI does, keeping the thread, and reports the state after",
    () => {
      const server = threadServer(running, (command) =>
        command.type === "run.interrupt" ? [stopped] : undefined,
      );
      return Effect.gen(function* () {
        expect(yield* stop).toEqual({
          server_id: "home",
          session_id: threadId,
          result: "stop_requested",
          dropped_message_ids: [],
          state: "interrupted",
          queued_messages: [],
          cursor: expect.any(String),
        });
        expect(server.sent).toEqual([
          {
            type: "run.interrupt",
            commandId: expect.any(String),
            threadId,
            runId: run().id,
            holdQueue: true,
          },
        ]);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect("stops work that is still starting or waiting for the user", () =>
    Effect.gen(function* () {
      for (const session of [
        projection({ runs: [run({ status: "preparing", startedAt: null })] }),
        projection({ runs: [run({ status: "starting", startedAt: null })] }),
        waitingForApproval,
      ]) {
        const server = threadServer(session);
        expect(yield* stop.pipe(Effect.provide(server.layer))).toMatchObject({
          result: "stop_requested",
        });
        expect(server.sent.map((command) => command.type)).toEqual(["run.interrupt"]);
      }
    }),
  );

  it.effect("holds every queued message, whoever queued it, as the UI does", () => {
    const server = threadServer(withQueue, queueServer);
    const status = callTool("get_session_status", { server_id: "home", session_id: threadId });
    return Effect.gen(function* () {
      const queue = (state: "waiting" | "held") =>
        ["from-bridge", "from-web"].map((message_id) => ({ message_id, state }));
      expect((yield* status).queued_messages).toEqual(queue("waiting"));
      expect((yield* stop).queued_messages).toEqual(queue("held"));
      expect(server.sent).toMatchObject([
        { type: "run.interrupt", runId: "run-1", holdQueue: true },
      ]);
      // A later status shows the queue is held, not about to run.
      expect((yield* status).queued_messages).toEqual(queue("held"));
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("issues no Stop for settled or idle sessions", () =>
    Effect.gen(function* () {
      const settled = threadServer(completed);
      expect(yield* stop.pipe(Effect.provide(settled.layer))).toMatchObject({
        result: "already_inactive",
        state: "completed",
      });
      expect(settled.sent).toEqual([]);
      const idle = threadServer(projection({ runs: [], items: [], messages: [] }));
      expect(yield* stop.pipe(Effect.provide(idle.layer))).toMatchObject({
        result: "already_inactive",
        state: "idle",
      });
    }),
  );

  it.effect("propagates the server's rejection", () => {
    const server = threadServer(running, undefined, {
      dispatch: () => Effect.fail(new BridgeError({ message: "Server refused Stop" })),
    });
    return Effect.gen(function* () {
      expect((yield* Effect.flip(stop)).message).toBe("Server refused Stop");
    }).pipe(Effect.provide(server.layer));
  });
});

describe("control_session resume_queue", () => {
  it.effect("releases a held queue with T3's queue.resume command", () => {
    const server = threadServer(held, queueServer);
    return Effect.gen(function* () {
      const resumed = yield* control("resume_queue");
      expect(resumed).toMatchObject({
        result: "queue_resumed",
        queued_messages: [
          { message_id: "from-bridge", state: "waiting" },
          { message_id: "from-web", state: "waiting" },
        ],
      });
      expect(server.sent).toEqual([
        { type: "queue.resume", commandId: expect.any(String), threadId },
      ]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("sends nothing when no queued message is held", () => {
    const server = threadServer(withQueue, queueServer);
    return Effect.gen(function* () {
      expect(yield* control("resume_queue")).toMatchObject({ result: "nothing_held" });
      expect(server.sent).toEqual([]);
    }).pipe(Effect.provide(server.layer));
  });
});

describe("control_session drop_queued", () => {
  it.effect("drops every queued message when message_ids is omitted", () => {
    const server = threadServer(withQueue, queueServer);
    return Effect.gen(function* () {
      expect(yield* control("drop_queued")).toMatchObject({
        result: "dropped",
        dropped_message_ids: ["from-bridge", "from-web"],
        queued_messages: [],
        state: "running",
      });
      expect(server.sent).toMatchObject([
        { type: "queued-run.cancel", runId: "run-2" },
        { type: "queued-run.cancel", runId: "run-3" },
      ]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("drops only the selected messages", () => {
    const server = threadServer(held, queueServer);
    return Effect.gen(function* () {
      expect(yield* control("drop_queued", ["from-web"])).toMatchObject({
        dropped_message_ids: ["from-web"],
        queued_messages: [{ message_id: "from-bridge", state: "held" }],
      });
      expect(server.sent).toMatchObject([{ type: "queued-run.cancel", runId: "run-3" }]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("drops nothing when any id is not queued: unknown, started, or already dropped", () => {
    const server = threadServer(withQueue, queueServer);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(control("drop_queued", ["from-web", "user-1", "missing"]));
      expect(error).toMatchObject({ code: "not_queued" });
      expect(error.message).toContain("user-1, missing");
      expect(error.message).toContain("Nothing was dropped");
      expect(server.sent).toEqual([]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reports what it dropped when a message starts before its turn to drop", () => {
    const server = threadServer(withQueue, undefined, {
      dispatch: (command) =>
        command.type === "queued-run.cancel" && command.runId === "run-3"
          ? Effect.fail(new BridgeError({ message: "Run run-3 is no longer queued." }))
          : Effect.succeed({ sequence: 1 }),
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(control("drop_queued"));
      expect(error.message).toContain(
        "Message from-web was not dropped; already dropped: from-bridge",
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("accepts message_ids only with drop_queued", () => {
    const server = threadServer(withQueue, queueServer);
    return Effect.gen(function* () {
      expect((yield* Effect.flip(control("stop", ["from-web"]))).message).toContain(
        "only to drop_queued",
      );
      expect(server.sent).toEqual([]);
    }).pipe(Effect.provide(server.layer));
  });
});
