import type {
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestratorMcpFailure,
  SuperThreadMemberOutcome,
  SuperThreadMemberRun,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { FollowRetrySchedule } from "../peer/RemoteDelegation.ts";
import { forkParked } from "../serverActivation.ts";
import { memberWakeCommandId } from "./superThreadWake.ts";

/** How long one wait on a member's run in a linked environment lasts before it waits again. */
const FOLLOW_WAIT_MS = 10 * 60 * 1_000;

/** Requests a person answers; tool calls and auth refreshes are T3's own. */
const WAITS_FOR_PERSON = new Set([
  "user_input",
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);

/** Refusals no later wait can change: the link, the thread or the run is gone. */
const isFinal = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "thread_not_found" ||
  error.code === "run_not_found" ||
  error.code === "invalid_request";

/**
 * Wakes a super thread when one of its members finishes a run, fails, or starts waiting for the
 * person. Members here are read from this server's events; a run the super thread started on a
 * member in a linked environment is followed there, as RemoteDelegation follows a remote task.
 */
export class SuperThreadMemberWatch extends Context.Service<
  SuperThreadMemberWatch,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/superThread/superThreadMemberWatch") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const followRetry = yield* FollowRetrySchedule;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;

  /** Local member → the super threads here that launched it, and each super thread's members. */
  const groupsOf = new Map<ThreadId, Set<ThreadId>>();
  const membersOf = new Map<ThreadId, ReadonlyArray<ThreadId>>();
  const following = new Set<string>();

  const index = (thread: OrchestrationV2AppThread) => {
    for (const member of membersOf.get(thread.id) ?? []) groupsOf.get(member)?.delete(thread.id);
    const members =
      thread.superThread === undefined || thread.deletedAt !== null
        ? []
        : thread.superThread.members
            .filter((member) => member.environmentId === hereId)
            .map((member) => member.threadId);
    membersOf.set(thread.id, members);
    for (const member of members) {
      const groups = groupsOf.get(member) ?? new Set();
      groups.add(thread.id);
      groupsOf.set(member, groups);
    }
  };

  const wake = (
    superThreadId: ThreadId,
    run: SuperThreadMemberRun,
    outcome: SuperThreadMemberOutcome,
    title?: string,
    requestId?: string,
  ) =>
    engine
      .dispatch({
        type: "super_thread.member.wake",
        commandId: memberWakeCommandId(superThreadId, run, outcome, requestId),
        threadId: superThreadId,
        run,
        outcome,
        ...(title === undefined ? {} : { title }),
      })
      .pipe(Effect.asVoid);

  const wakeGroups = Effect.fnUntraced(function* (
    memberId: ThreadId,
    runId: SuperThreadMemberRun["runId"],
    outcome: SuperThreadMemberOutcome,
    requestId?: string,
  ) {
    const groups = groupsOf.get(memberId);
    if (groups === undefined || groups.size === 0) return;
    const { title } = yield* projections.getThread(memberId);
    for (const superThreadId of groups) {
      yield* wake(
        superThreadId,
        { environmentId: hereId, threadId: memberId, runId },
        outcome,
        title,
        requestId,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking a super thread for its member failed", {
            superThreadId,
            memberId,
            cause,
          }),
        ),
      );
    }
  });

  /** How this server reads a member's thread there: as its super thread, one namespace per group. */
  const followScope = (
    superThread: Pick<OrchestrationV2AppThread, "id" | "providerInstanceId">,
    run: SuperThreadMemberRun,
  ): McpInvocationContext.McpThreadInvocationScope => ({
    environmentId: hereId,
    requestNamespace: `super-thread:${superThread.id}`,
    thread: {
      threadId: superThread.id,
      providerSessionId: `super-thread-member:${run.threadId}`,
      providerInstanceId: superThread.providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  /** Waits for the run there to end, then reports it; an unreachable machine is retried. */
  const followRun = Effect.fn("SuperThreadMemberWatch.followRun")(
    function* (
      superThread: Pick<OrchestrationV2AppThread, "id" | "providerInstanceId">,
      run: SuperThreadMemberRun,
    ) {
      const outcome = yield* forwarding
        .waitForThread(followScope(superThread, run), run.environmentId, {
          threadId: run.threadId,
          runId: run.runId,
          timeoutMs: FOLLOW_WAIT_MS,
          untilDelegatedWorkSettled: true,
        })
        .pipe(
          Effect.repeat({ while: (waited) => waited.timedOut }),
          Effect.map((waited): SuperThreadMemberOutcome => {
            const status = waited.resultRun?.status ?? waited.status;
            return status === "completed" || status === "failed" ? status : "stopped";
          }),
          Effect.retry({ schedule: followRetry, while: (error) => !isFinal(error) }),
          // Gone there, or no link to reach it by: the follow ends without a wake.
          Effect.orElseSucceed((): SuperThreadMemberOutcome => "stopped"),
        );
      yield* wake(superThread.id, run, outcome);
    },
    Effect.ignoreCause({ log: true }),
  );

  const follow = (
    superThread: Pick<OrchestrationV2AppThread, "id" | "providerInstanceId">,
    run: SuperThreadMemberRun,
  ) => {
    const key = `${superThread.id} ${run.environmentId} ${run.threadId} ${run.runId}`;
    if (following.has(key)) return Effect.void;
    following.add(key);
    return followRun(superThread, run).pipe(
      Effect.ensuring(Effect.sync(() => following.delete(key))),
      Effect.forkIn(followers),
      Effect.asVoid,
    );
  };

  const followAll = (thread: OrchestrationV2AppThread) =>
    Effect.forEach(thread.superThread?.following ?? [], (run) => follow(thread, run), {
      discard: true,
    });

  const superThreadOf = (event: OrchestrationV2DomainEvent) => {
    if (!event.type.startsWith("thread.") || !("payload" in event)) return undefined;
    const thread = event.payload as Partial<OrchestrationV2AppThread>;
    return thread.id === event.threadId && thread.superThread !== undefined
      ? (thread as OrchestrationV2AppThread)
      : undefined;
  };

  // Runs for every domain event; most return before any read.
  const handle: SuperThreadMemberWatch["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      const superThread = superThreadOf(event);
      if (superThread !== undefined) {
        index(superThread);
        if (superThread.deletedAt === null) yield* followAll(superThread);
        return;
      }
      if (event.type === "run.updated") {
        const status = event.payload.status;
        if (status !== "completed" && status !== "failed") return;
        yield* wakeGroups(event.threadId, event.payload.id, status);
        return;
      }
      if (
        event.type === "runtime-request.updated" &&
        event.payload.status === "pending" &&
        WAITS_FOR_PERSON.has(event.payload.kind) &&
        event.runId !== undefined
      ) {
        yield* wakeGroups(event.threadId, event.runId, "waiting", event.payload.id);
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("super thread member watch failed on an event", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: SuperThreadMemberWatch["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // Subscribed before the scan, so a change between the two is not missed.
        yield* Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(followers, { startImmediately: true }),
        );
        // A settled super thread wakes for nothing; it is indexed when it next unsettles.
        const { threads } = yield* projections.getShellSnapshot({ unsettledOnly: true });
        for (const shell of threads) {
          if (shell.superThread === undefined) continue;
          const thread = yield* projections.getThread(shell.id);
          index(thread);
          yield* followAll(thread);
        }
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return SuperThreadMemberWatch.of({ start, handle });
});

export const layer = Layer.effect(SuperThreadMemberWatch, make);

/** Watches members for the server's lifetime, including what a restart left followed. */
export const layerStarted = Layer.effectDiscard(
  SuperThreadMemberWatch.pipe(Effect.flatMap((watch) => watch.start())),
).pipe(Layer.provide(layer.pipe(Layer.provide(ProjectionStore.layer))));
