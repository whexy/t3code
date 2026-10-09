import {
  EnvironmentAuthorizationError,
  GitCommandError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2ThreadLaunchError,
  ProjectMutationError,
  SourceControlRepositoryError,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type ProjectCloneSnapshot,
  type ProjectCloneStartInput,
  type ProjectCloneStartResult,
  type ProjectMutation,
  type ThreadId,
  type UsageSummaryInput,
  type VcsCreateRefInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsSwitchRefInput,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import { orchestrationProtocolCompatibilityError } from "@t3tools/client-runtime/connection";
import {
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
} from "@t3tools/client-runtime/environment";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  type RemoteEnvironmentRequestError,
  type WsRpcProtocolClient,
} from "@t3tools/client-runtime/rpc";
import { BridgeError } from "./errors.ts";
export { BridgeError } from "./errors.ts";
import { waitForThreadState } from "./threadWatch.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { CLIENT_METADATA, support, tooOldMessage } from "./access.ts";
import { Registry, type ServerRecord } from "./registry.ts";

const isBridgeError = Schema.is(BridgeError);

const REQUEST_TIMEOUT_MS = 15_000;
/** One inspection reads every ref page plus a status per checkout over a single socket. */
const INSPECTION_TIMEOUT_MS = 60_000;
const WORKTREE_SETUP_TIMEOUT_MS = 10 * 60_000;
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isActionError = Schema.is(
  Schema.Union([
    GitCommandError,
    OrchestrationV2DispatchCommandError,
    OrchestrationV2ThreadLaunchError,
  ]),
);

/** What project creation fails with when the server refused before registering anything. */
const isProjectRejection = Schema.is(
  Schema.Union([
    ProjectMutationError,
    OrchestrationDispatchCommandError,
    SourceControlRepositoryError,
  ]),
);

/**
 * A project creation request that failed before the server confirmed a
 * project. `unconfirmed` is the message for a timeout or dropped socket,
 * which says nothing about how far the server got.
 */
export const projectCreationFailure = (
  serverId: string,
  error: { readonly message: string },
  unconfirmed: string,
) =>
  isProjectRejection(error)
    ? new BridgeError({
        code: "project_not_created",
        state: "not_created",
        message: `T3 server "${serverId}" did not create the project: ${error.message} Nothing was registered; fix the input and retry.`,
      })
    : new BridgeError({ code: "project_unconfirmed", state: "unknown", message: unconfirmed });

/** What the model reads when the server turns a command down. */
const commandFailure = (serverId: string, command: OrchestrationV2Command) => {
  switch (command.type) {
    case "message.dispatch":
      return `T3 server "${serverId}" did not accept the message.`;
    case "run.interrupt":
      return `T3 server "${serverId}" did not accept the interruption.`;
    case "queued-run.cancel":
      return `T3 server "${serverId}" could not cancel a queued message.`;
    default:
      return `T3 server "${serverId}" did not accept the response.`;
  }
};

/**
 * One paired T3 server, reached the way any remote client reaches it.
 * Reads use bearer-authenticated HTTP. Commands, launches, and the server
 * config use a short-lived RPC socket: the config has no HTTP endpoint.
 */
const makeEnvironment = Effect.fn("makeEnvironment")(function* (entry: ServerRecord) {
  const httpClient = yield* HttpClient.HttpClient;
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const httpBaseUrl = normalizeHttpBaseUrl(entry.url);
  const wsBaseUrl = deriveWsBaseUrl(httpBaseUrl);
  const headers = {
    authorization: `Bearer ${entry.token}`,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  } as const;

  const fail = (operation: string, failure: string | BridgeError, detail: string) =>
    Effect.logWarning("T3 server request failed", { server: entry.id, operation, detail }).pipe(
      Effect.andThen(
        Effect.fail(typeof failure === "string" ? new BridgeError({ message: failure }) : failure),
      ),
    );
  const failRequest = (operation: string) => (error: RemoteEnvironmentRequestError) => {
    switch (error._tag) {
      case "EnvironmentAuthInvalidError":
        return fail(
          operation,
          `T3 server "${entry.id}" rejected the bridge's token. Issue a new one and update the bridge configuration.`,
          error.message,
        );
      case "RemoteEnvironmentAuthFetchError":
      case "RemoteEnvironmentAuthTimeoutError":
        return fail(operation, `T3 server "${entry.id}" is unreachable.`, error.message);
      default:
        return fail(operation, `T3 server "${entry.id}": ${error.message}`, error.message);
    }
  };

  const orchestration = <A, E>(
    path: string,
    request: (
      client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<"orchestration">>>,
    ) => Effect.Effect<A, E>,
  ) =>
    makeEnvironmentHttpApiGroupClient(httpBaseUrl, "orchestration").pipe(
      Effect.flatMap((client) =>
        executeEnvironmentHttpRequest(
          environmentEndpointUrl(httpBaseUrl, path),
          REQUEST_TIMEOUT_MS,
          request(client),
        ),
      ),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const rpc = <A, E extends { readonly message: string }>(
    operation: string,
    failureMessage: string,
    use: (client: WsRpcProtocolClient) => Effect.Effect<A, E>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    projectCreation = false,
  ) =>
    Effect.gen(function* () {
      const socketUrl = new URL(
        yield* resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl,
          httpBaseUrl,
          bearerToken: entry.token,
          clientMetadata: CLIENT_METADATA,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }).pipe(Effect.catch(failRequest(operation))),
      );
      socketUrl.searchParams.set(
        ORCHESTRATION_PROTOCOL_QUERY_PARAM,
        String(ORCHESTRATION_PROTOCOL_VERSION),
      );
      const protocol = yield* Layer.build(
        Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Socket.layerWebSocket(socketUrl.toString(), { openTimeout: REQUEST_TIMEOUT_MS }),
              RpcSerialization.layerJson,
            ),
          ),
        ),
      );
      const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
      return yield* use(client).pipe(
        Effect.timeout(timeoutMs),
        Effect.catch((error) => {
          if (isBridgeError(error)) return Effect.fail(error);
          if (isAuthorizationError(error)) {
            // Tokens keep the permissions granted at pairing, so only a re-pair adds one.
            const permission = error.requiredPermission ?? error.requiredScope;
            return fail(
              operation,
              `T3 server "${entry.id}" has not granted the bridge the ${permission} permission. Re-pair it on the bridge admin page with a pairing link that includes that permission.`,
              error.message,
            );
          }
          if (projectCreation) {
            return fail(
              operation,
              projectCreationFailure(entry.id, error, failureMessage),
              error.message,
            );
          }
          return fail(
            operation,
            isActionError(error) ? `${failureMessage} ${error.message}` : failureMessage,
            error.message,
          );
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
    );

  const shell = orchestration("/api/orchestration/shell", (client) =>
    client.shellSnapshot({ headers }),
  ).pipe(Effect.catch(failRequest("shell")));

  /**
   * The thread's control state (runs, requests, checkpoints) in full, with
   * only the recent timeline: status never needs the whole history.
   */
  const thread = (threadId: ThreadId) =>
    orchestration(`/api/orchestration/threads/${threadId}/bounded`, (client) =>
      client.threadBoundedSnapshot({ headers, params: { threadId }, query: {} }),
    ).pipe(
      Effect.map((snapshot) => snapshot.projection),
      Effect.catch((error) =>
        error._tag === "EnvironmentResourceNotFoundError"
          ? Effect.fail(
              new BridgeError({
                message: `Session ${threadId} was not found on T3 server "${entry.id}". It may have been archived or deleted.`,
              }),
            )
          : failRequest("thread")(error),
      ),
    );

  const serverConfig = rpc(
    "server config",
    `T3 server "${entry.id}" did not return its configuration.`,
    (client) => client[WS_METHODS.serverGetConfig]({}),
  ).pipe(
    Effect.flatMap((config) => {
      const incompatible = orchestrationProtocolCompatibilityError(config.environment);
      return incompatible === null
        ? Effect.succeed(config)
        : fail("server config", incompatible.detail, incompatible.detail);
    }),
  );

  const dispatch = (command: OrchestrationV2Command) =>
    rpc(command.type, commandFailure(entry.id, command), (client) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command),
    );

  /** Creates the thread and sends its first message; workspace preparation continues on the server. */
  const launchThread = (input: OrchestrationV2ThreadLaunchInput) =>
    rpc("launch thread", `T3 server "${entry.id}" could not start the session.`, (client) =>
      client[ORCHESTRATION_V2_WS_METHODS.launchThread](input),
    ).pipe(Effect.map((result) => result.projection));

  /** Snapshot + replay through the clients' projection reducer, with no polling. */
  const waitForThread = (
    threadId: ThreadId,
    ready: (projection: OrchestrationV2ThreadProjection) => boolean,
  ) =>
    rpc(
      "watch thread",
      `T3 server "${entry.id}" could not watch the session.`,
      (client) =>
        waitForThreadState(
          client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }),
          ready,
        ),
      WORKTREE_SETUP_TIMEOUT_MS,
    );

  return {
    id: entry.id,
    name: entry.name,
    expiresAt: entry.expiresAt,
    shell,
    thread,
    serverConfig,
    dispatch,
    launchThread,
    waitForThread,
    createRef: (input: VcsCreateRefInput) =>
      rpc("create branch", `T3 server "${entry.id}" could not create the branch.`, (client) =>
        client[WS_METHODS.vcsCreateRef](input),
      ),
    switchRef: (input: VcsSwitchRefInput) =>
      rpc("switch branch", `T3 server "${entry.id}" could not switch branches.`, (client) =>
        client[WS_METHODS.vcsSwitchRef](input),
      ),
    listRefs: (input: VcsListRefsInput) =>
      rpc("list branches", `T3 server "${entry.id}" could not list branches.`, (client) =>
        client[WS_METHODS.vcsListRefs](input),
      ),
    readVcs: <A>(use: (reads: VcsReads) => Effect.Effect<A, VcsReadError>) =>
      rpc(
        "inspect repository",
        `T3 server "${entry.id}" could not read the repository.`,
        (client) =>
          use({
            listRefs: (input) =>
              client[WS_METHODS.vcsListRefs](input).pipe(
                Effect.mapError((error) =>
                  isAuthorizationError(error)
                    ? error
                    : new BridgeError({
                        message: `T3 server "${entry.id}" could not list branches: ${error.message}`,
                      }),
                ),
              ),
            status: (cwd) =>
              client[WS_METHODS.subscribeVcsStatus]({ cwd, includeRemote: false }).pipe(
                Stream.runHead,
                Effect.mapError((error) =>
                  isAuthorizationError(error)
                    ? error
                    : new BridgeError({
                        message: `T3 server "${entry.id}" could not read Git status for ${cwd}: ${error.message}`,
                      }),
                ),
                Effect.flatMap((first) =>
                  Option.isSome(first) && first.value._tag === "snapshot"
                    ? Effect.succeed({ local: first.value.local, remote: first.value.remote })
                    : Effect.fail(
                        new BridgeError({
                          message: `T3 server "${entry.id}" sent no Git status for ${cwd}.`,
                        }),
                      ),
                ),
              ),
          }),
        INSPECTION_TIMEOUT_MS,
      ),
    createProject: (mutation: Extract<ProjectMutation, { readonly type: "project.create" }>) =>
      rpc(
        "create project",
        `T3 server "${entry.id}" did not confirm whether it registered the project. Call list_projects before retrying.`,
        (client) => client[WS_METHODS.projectsMutate](mutation),
        REQUEST_TIMEOUT_MS,
        true,
      ),
    cloneProject: (input: ProjectCloneStartInput) =>
      rpc(
        "clone project",
        `T3 server "${entry.id}" did not confirm whether it registered the project or started the clone into ${input.destinationPath}. Call list_projects before retrying; a registered project's clone may still be running.`,
        (client) =>
          cloneProjectAndWait(
            {
              start: (input) => client[WS_METHODS.projectCloneStart](input),
              changes: client[WS_METHODS.subscribeProjectClones]({}),
            },
            input,
          ),
        10 * 60_000,
        true,
      ),
    usageSummary: (input: UsageSummaryInput) =>
      rpc(
        "usage summary",
        `T3 server "${entry.id}" did not return usage. It may need updating or its history may be unavailable.`,
        (client) => client[WS_METHODS.serverGetUsageSummary](input),
        // Cold scans read provider history and pricing before answering.
        120_000,
      ),
  };
});

/** Follow the server's clone events so success means a session can start immediately. */
export const cloneProjectAndWait = Effect.fn("cloneProjectAndWait")(function* <E, R>(
  client: {
    readonly start: (input: ProjectCloneStartInput) => Effect.Effect<ProjectCloneStartResult, E, R>;
    readonly changes: Stream.Stream<ReadonlyArray<ProjectCloneSnapshot>, E, R>;
  },
  input: ProjectCloneStartInput,
) {
  // A failed start registered nothing; from here on the project exists.
  const result = yield* client.start(input);
  const terminal = yield* client.changes.pipe(
    Stream.map((clones) => clones.find((clone) => clone.projectId === input.projectId)),
    Stream.filter((clone) => clone === undefined || clone.phase !== "running"),
    Stream.runHead,
  );
  const clone = Option.getOrUndefined(terminal);
  if (clone?.phase === "done") return result;
  const registered = `Project ${input.projectId} is registered at ${result.cwd}`;
  if (clone?.phase === "failed" || clone?.phase === "cancelled") {
    return yield* new BridgeError({
      code: "clone_failed",
      state: "registered",
      message: `${registered}, but its clone ${clone.phase === "failed" ? `failed: ${clone.error ?? "the repository could not be cloned."}` : "was cancelled."} Retry the clone in T3 Code, or delete the project there before reusing the path.`,
    });
  }
  return yield* new BridgeError({
    code: "clone_unconfirmed",
    state: "registered",
    message: `${registered}, but the server stopped reporting its clone, which may still be running. Check the project in T3 Code before retrying.`,
  });
});

/**
 * Git reads for inspection. Neither fetches, pulls, nor switches: refs come
 * from the server's local ref snapshot, and status is the passive subscription
 * that reports cached remote status without starting the remote poller.
 */
/** Authorization refusals pass through so the request names the permission to re-pair for. */
type VcsReadError = BridgeError | EnvironmentAuthorizationError;

export interface VcsReads {
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, VcsReadError>;
  readonly status: (cwd: string) => Effect.Effect<
    {
      readonly local: VcsStatusLocalResult;
      /** Null until the server has checked this checkout's remote status. */
      readonly remote: VcsStatusRemoteResult | null;
    },
    VcsReadError
  >;
}

export type T3Environment = Effect.Success<ReturnType<typeof makeEnvironment>>;

/**
 * Paired servers, read from the registry on every call so admin edits apply
 * at once. A server too old for this bridge counts as disabled until it is
 * upgraded; the check runs per call, so the upgrade takes effect on the next one.
 */
export class Environments extends Context.Service<
  Environments,
  {
    readonly enabled: Effect.Effect<ReadonlyArray<T3Environment>>;
    readonly get: (serverId: string) => Effect.Effect<T3Environment, BridgeError>;
  }
>()("@t3tools/mcp/environment/Environments") {}

export const layer = Layer.effect(
  Environments,
  Effect.gen(function* () {
    const registry = yield* Registry;
    const services = yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>();
    const build = (record: ServerRecord) => makeEnvironment(record).pipe(Effect.provide(services));
    const serverSupport = (record: ServerRecord) => support(record).pipe(Effect.provide(services));
    return Environments.of({
      enabled: registry.state.pipe(
        Effect.flatMap((state) =>
          Effect.forEach(
            state.servers.filter((server) => server.enabled),
            (server) =>
              serverSupport(server).pipe(
                Effect.flatMap((supported) =>
                  supported.status === "too_old"
                    ? Effect.succeed([])
                    : Effect.map(build(server), (built) => [built]),
                ),
              ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.map((environments) => environments.flat()),
      ),
      get: (serverId) =>
        registry.state.pipe(
          Effect.flatMap((state) => {
            const server = state.servers.find((candidate) => candidate.id === serverId);
            if (server?.enabled === true) {
              return serverSupport(server).pipe(
                Effect.flatMap((supported) =>
                  supported.status === "too_old"
                    ? Effect.fail(
                        new BridgeError({
                          code: "server_too_old",
                          message: tooOldMessage(server.id, supported.serverVersion),
                        }),
                      )
                    : build(server),
                ),
              );
            }
            const enabled = state.servers.filter((candidate) => candidate.enabled);
            return Effect.fail(
              new BridgeError({
                message:
                  server === undefined
                    ? `Unknown server_id "${serverId}". Available servers: ${enabled.map((candidate) => candidate.id).join(", ") || "none"}.`
                    : `Server "${serverId}" is disabled on the bridge.`,
              }),
            );
          }),
        ),
    });
  }),
);
