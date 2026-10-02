import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId, type ClientOrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { BridgeError, type T3Environment } from "./environment.ts";
import { makeMessageQueue } from "./messageQueue.ts";
import { activity, NOW, thread } from "./testing.ts";

type StartTurn = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
const command = (id: string): StartTurn => ({
  type: "thread.turn.start",
  commandId: CommandId.make(id),
  threadId: thread().id,
  message: { messageId: MessageId.make(id), role: "user", text: id, attachments: [] },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: NOW,
});

const fixture = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make(thread());
  const observed = yield* Queue.unbounded<boolean>();
  const sent = yield* Queue.unbounded<StartTurn>();
  const environment: T3Environment = {
    id: "home",
    name: "Home",
    expiresAt: NOW,
    shell: Effect.die("unused"),
    dispatchCommand: () => Effect.die("unused"),
    createRef: () => Effect.die("unused"),
    switchRef: () => Effect.die("unused"),
    listRefs: () => Effect.die("unused"),
    createProject: () => Effect.die("unused"),
    cloneProject: () => Effect.die("unused"),
    usageSummary: () => Effect.die("unused"),
    serverConfig: Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    thread: () =>
      SubscriptionRef.get(state).pipe(Effect.map((thread) => ({ snapshotSequence: 1, thread }))),
    startTurn: (command) => Queue.offer(sent, command).pipe(Effect.as({ sequence: 1 })),
    waitForThread: (_id, ready) =>
      SubscriptionRef.changes(state).pipe(
        Stream.mapEffect((thread) =>
          Effect.gen(function* () {
            const due = ready(thread, NOW);
            yield* Queue.offer(observed, due);
            return { thread, due };
          }),
        ),
        Stream.filter((item) => item.due),
        Stream.take(1),
        Stream.runCollect,
        Effect.map((items) => items[0]!.thread),
      ),
  };
  return { state, observed, sent, environment, queue: yield* makeMessageQueue };
});

const toolFinished = (id: string) => thread({ activities: [activity(id, "tool.completed", 20)] });
const completed = thread({
  session: { ...thread().session!, status: "ready", activeTurnId: null },
  latestTurn: { ...thread().latestTurn!, state: "completed", completedAt: NOW },
});

describe("MCP message queue", () => {
  it.effect("holds a running message until a new tool completion, then dispatches once", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const worker = yield* f.queue.enqueue(f.environment, thread(), command("one"));
      expect(yield* Queue.take(f.observed)).toBe(false);
      expect(f.queue.list("home", thread().id)).toEqual([{ message_id: "one", state: "queued" }]);
      yield* SubscriptionRef.set(f.state, toolFinished("tool-1"));
      expect(yield* Queue.take(f.observed)).toBe(true);
      expect(yield* Queue.take(f.sent)).toMatchObject({
        message: { text: "one" },
        type: "thread.turn.start",
      });
      yield* Fiber.join(worker);
      expect(f.queue.list("home", thread().id)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("releases when the turn ends without any tool completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const worker = yield* f.queue.enqueue(f.environment, thread(), command("one"));
      expect(yield* Queue.take(f.observed)).toBe(false);
      yield* SubscriptionRef.set(f.state, completed);
      expect(yield* Queue.take(f.observed)).toBe(true);
      expect((yield* Queue.take(f.sent)).message.text).toBe("one");
      yield* Fiber.join(worker);
    }).pipe(Effect.scoped),
  );

  it.effect("holds during startup and while approval or input is pending", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const starting = thread({ session: { ...thread().session!, status: "starting" } });
      yield* SubscriptionRef.set(f.state, starting);
      const worker = yield* f.queue.enqueue(f.environment, starting, command("one"));
      expect(yield* Queue.take(f.observed)).toBe(false);
      for (const kind of ["approval.requested", "user-input.requested"]) {
        yield* SubscriptionRef.set(
          f.state,
          thread({
            activities: [
              activity("tool-1", "tool.completed", 20),
              activity("ask", kind, 21, {
                requestId: "r",
                requestKind: "command",
                questions: [{ id: "q", header: "Choice", question: "Which?", options: [] }],
              }),
            ],
          }),
        );
        expect(yield* Queue.take(f.observed)).toBe(false);
      }
      yield* SubscriptionRef.set(f.state, toolFinished("tool-1"));
      expect(yield* Queue.take(f.observed)).toBe(true);
      yield* Queue.take(f.sent);
      yield* Fiber.join(worker);
    }).pipe(Effect.scoped),
  );

  it.effect("sends FIFO with one message per tool boundary", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const worker = yield* f.queue.enqueue(f.environment, thread(), command("one"));
      expect(yield* Queue.take(f.observed)).toBe(false);
      yield* f.queue.enqueue(f.environment, thread(), command("two"));
      yield* SubscriptionRef.set(f.state, toolFinished("tool-1"));
      expect(yield* Queue.take(f.observed)).toBe(true);
      expect((yield* Queue.take(f.sent)).message.text).toBe("one");
      expect(yield* Queue.take(f.observed)).toBe(false);
      yield* SubscriptionRef.set(f.state, toolFinished("tool-2"));
      expect(yield* Queue.take(f.observed)).toBe(true);
      expect((yield* Queue.take(f.sent)).message.text).toBe("two");
      yield* Fiber.join(worker);
    }).pipe(Effect.scoped),
  );

  it.effect("Stop cancels held messages and prevents them from restarting the turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const worker = yield* f.queue.enqueue(f.environment, thread(), command("one"));
      expect(yield* Queue.take(f.observed)).toBe(false);
      expect(yield* f.queue.cancel("home", thread().id)).toEqual(["one"]);
      yield* Fiber.await(worker);
      expect(f.queue.list("home", thread().id)).toEqual([
        { message_id: "one", state: "cancelled" },
      ]);
      expect(yield* Queue.size(f.sent)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "retains structured delivery failures and cancellation instead of silently dropping messages",
    () =>
      Effect.gen(function* () {
        for (const code of ["unreachable", "queue_cancelled"]) {
          const f = yield* fixture;
          const worker = yield* f.queue.enqueue(
            {
              ...f.environment,
              waitForThread: () =>
                Effect.fail(new BridgeError({ code, message: "Cannot deliver" })),
            },
            thread(),
            command("one"),
          );
          yield* Fiber.join(worker);
          expect(f.queue.list("home", thread().id)).toEqual([
            {
              message_id: "one",
              state: code === "queue_cancelled" ? "cancelled" : "failed",
              error: "Cannot deliver",
            },
          ]);
          expect(yield* Queue.size(f.sent)).toBe(0);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("reports dispatch failure without replaying the message", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* SubscriptionRef.set(f.state, completed);
      const worker = yield* f.queue.enqueue(
        {
          ...f.environment,
          startTurn: () => Effect.fail(new BridgeError({ message: "Rejected" })),
        },
        thread(),
        command("one"),
      );
      yield* Fiber.join(worker);
      expect(f.queue.list("home", thread().id)).toEqual([
        { message_id: "one", state: "failed", error: "Rejected" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("isolates queues by server even when session ids match", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const homeWorker = yield* f.queue.enqueue(f.environment, thread(), command("home-message"));
      expect(yield* Queue.take(f.observed)).toBe(false);
      const remote = { ...f.environment, id: "remote" };
      const remoteWorker = yield* f.queue.enqueue(remote, thread(), command("remote-message"));
      expect(yield* Queue.take(f.observed)).toBe(false);
      expect(yield* f.queue.cancel("home", thread().id)).toEqual(["home-message"]);
      yield* Fiber.await(homeWorker);
      expect(f.queue.list("remote", thread().id)).toEqual([
        { message_id: "remote-message", state: "queued" },
      ]);
      yield* SubscriptionRef.set(f.state, completed);
      expect(yield* Queue.take(f.observed)).toBe(true);
      expect((yield* Queue.take(f.sent)).message.text).toBe("remote-message");
      yield* Fiber.join(remoteWorker);
    }).pipe(Effect.scoped),
  );
});
