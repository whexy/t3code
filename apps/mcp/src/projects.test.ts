import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SourceControlRepositoryError,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadLaunchInput,
  type ProjectCloneSnapshot,
  type ProjectCloneStartInput,
  type ProjectMutation,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { BridgeError, cloneProjectAndWait } from "./environment.ts";
import {
  appThread,
  at,
  bridgeLayer,
  callTool as handle,
  fakeEnvironment,
  projection,
  run,
} from "./testing.ts";
import { BridgeToolkit } from "./tools.ts";

const config: ServerConfig = {
  environment: {
    environmentId: EnvironmentId.make("home"),
    label: "Home",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "test",
    capabilities: { repositoryIdentity: true, connectionProbe: true, projectCloneTracking: true },
  },
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/srv",
  keybindingsConfigPath: "/srv/keybindings.json",
  keybindings: [],
  issues: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/srv/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
  providers: [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: at(0),
      models: [
        { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null, isDefault: true },
      ],
      slashCommands: [],
      skills: [],
    },
  ],
};

const isBridgeError = Schema.is(BridgeError);
const decodeProjectInput = Schema.decodeUnknownEffect(
  BridgeToolkit.tools.create_project.parametersSchema,
);

function bridge(failure?: string, connectionFailure?: string) {
  const projects: Array<OrchestrationProjectShell> = [];
  const mutations: Array<ProjectMutation> = [];
  const launches: Array<OrchestrationV2ThreadLaunchInput> = [];
  const clones: Array<ProjectCloneStartInput> = [];
  const save = (id: ProjectId, title: string, path: string) => {
    if (failure) throw new BridgeError({ message: failure });
    if (projects.some((project) => project.workspaceRoot === path)) {
      throw new BridgeError({
        message: "An active project already exists for this workspace root.",
      });
    }
    const project = {
      id,
      title,
      workspaceRoot: path,
      defaultModelSelection: null,
      scripts: [],
      createdAt: at(0),
      updatedAt: at(0),
    };
    projects.push(project);
    return { ...project, deletedAt: null };
  };
  const environment = fakeEnvironment({
    expiresAt: "2027-01-01T00:00:00.000Z",
    serverConfig: connectionFailure
      ? Effect.fail(new BridgeError({ message: connectionFailure }))
      : Effect.succeed(config),
    shell: Effect.sync(() => ({
      schemaVersion: 1,
      snapshotSequence: projects.length,
      projects: [...projects],
      threads: [],
      archivedThreads: [],
    })),
    createProject: (mutation) =>
      Effect.try({
        try: () => {
          const project = save(
            mutation.projectId,
            mutation.title,
            mutation.workspaceRoot.replace("~", "/home/user"),
          );
          mutations.push(mutation);
          return project;
        },
        catch: (error) =>
          isBridgeError(error) ? error : new BridgeError({ message: String(error) }),
      }),
    cloneProject: (input) =>
      Effect.try({
        try: () => {
          save(input.projectId, input.title, input.destinationPath);
          clones.push(input);
          return {
            projectId: input.projectId,
            cwd: input.destinationPath,
            remoteUrl: input.remoteUrl ?? "https://host/repo",
            repository: null,
          };
        },
        catch: (error) =>
          isBridgeError(error) ? error : new BridgeError({ message: String(error) }),
      }),
    launchThread: (input) =>
      Effect.sync(() => {
        launches.push(input);
        return projection({
          thread: appThread({ id: input.threadId!, projectId: input.projectId }),
          runs: [run({ userMessageId: input.initialMessage!.messageId!, status: "starting" })],
        });
      }),
  });
  return { projects, mutations, launches, clones, layer: bridgeLayer(environment) };
}

describe("create_project", () => {
  it.effect(
    "discovers a server with no projects, registers a folder, then starts a session in it",
    () => {
      const fixture = bridge();
      return Effect.gen(function* () {
        expect(yield* handle("list_projects", {})).toMatchObject({
          servers: [{ server_id: "home" }],
          projects: [],
        });
        const created = yield* handle("create_project", {
          server_id: "home",
          source: { type: "local", path: "~/projects/app" },
        });
        expect(created).toMatchObject({
          server_id: "home",
          name: "app",
          path: "/home/user/projects/app",
        });
        if (!("project_id" in created)) return yield* Effect.die(created);
        const session = yield* handle("create_session", {
          server_id: "home",
          project_id: created.project_id,
          task: "Build the app",
        });
        expect(session).toMatchObject({
          project_id: created.project_id,
          server_id: "home",
          state: "queued",
        });
        expect(fixture.mutations).toMatchObject([
          {
            type: "project.create",
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: null,
          },
        ]);
        expect(fixture.launches).toMatchObject([{ projectId: created.project_id }]);
        const error = yield* Effect.flip(
          handle("create_project", {
            server_id: "home",
            source: { type: "local", path: "~/projects/app" },
          }),
        );
        expect(error.message).toContain("already exists");
        expect(fixture.projects).toHaveLength(1);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect(
    "uses the canonical clone inputs and UI transport defaults for every repository source",
    () => {
      const fixture = bridge();
      return Effect.gen(function* () {
        yield* handle("create_project", {
          server_id: "home",
          source: { type: "url", remote_url: "owner/repo", destination_path: "/srv/url" },
        });
        expect(fixture.clones[0]).toMatchObject({
          remoteUrl: "https://github.com/owner/repo.git",
          destinationPath: "/srv/url",
        });
        for (const type of ["github", "gitlab", "forgejo", "bitbucket", "azure-devops"] as const) {
          yield* handle("create_project", {
            server_id: "home",
            source: {
              type,
              repository: "owner/repo",
              destination_path: `/srv/${type}`,
              protocol: null,
            },
          });
          expect(fixture.clones.at(-1)).toMatchObject({
            provider: type,
            repository: "owner/repo",
            protocol: type === "github" || type === "forgejo" ? "https" : "ssh",
          });
        }
        yield* handle("create_project", {
          server_id: "home",
          source: {
            type: "github",
            repository: "owner/repo",
            destination_path: "/srv/ssh",
            protocol: "ssh",
          },
        });
        expect(fixture.clones.at(-1)?.protocol).toBe("ssh");
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect(
    "rejects invalid sources, missing inputs, blank paths, explicit relative paths, and unsupported Windows paths",
    () => {
      const fixture = bridge();
      return Effect.gen(function* () {
        for (const source of [
          { type: "unknown", path: "/srv/app" },
          { type: "url", destination_path: "/srv/app" },
          { type: "github", destination_path: "/srv/app" },
          { type: "local", path: " " },
          { type: "local", path: "./app" },
          { type: "local", path: "C:\\app" },
          { type: "url", remote_url: "owner/repo", destination_path: "../repo" },
          {
            type: "github",
            repository: "owner/repo",
            destination_path: "/srv/app",
            protocol: "ftp",
          },
        ]) {
          const decoded = yield* decodeProjectInput({ server_id: "home", source }).pipe(
            Effect.result,
          );
          if (decoded._tag === "Success") {
            expect(["./app", "C:\\app", "../repo"]).toContain(
              source.path ?? source.destination_path,
            );
            const failed = yield* handle("create_project", decoded.success).pipe(Effect.result);
            expect(failed._tag).toBe("Failure");
          }
        }
        expect(fixture.projects).toEqual([]);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("surfaces server selection and canonical server failures", () => {
    const fixture = bridge("Destination path already exists and is not empty.");
    return Effect.gen(function* () {
      const unknown = yield* Effect.flip(
        handle("create_project", {
          server_id: "missing",
          source: { type: "local", path: "/srv/app" },
        }),
      );
      expect(unknown.message).toContain("Unknown server_id");
      const error = yield* Effect.flip(
        handle("create_project", {
          server_id: "home",
          source: { type: "url", remote_url: "bad-url", destination_path: "/srv/app" },
        }),
      );
      expect(error.message).toBe("Destination path already exists and is not empty.");
      expect(fixture.projects).toEqual([]);
    }).pipe(Effect.provide(fixture.layer));
  });
  it.effect("reports an inaccessible server before any project mutation", () => {
    const fixture = bridge(undefined, 'T3 server "home" is unreachable.');
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        handle("create_project", {
          server_id: "home",
          source: { type: "local", path: "/srv/app" },
        }),
      );
      expect(error.message).toContain("unreachable");
      expect(fixture.projects).toEqual([]);
      expect(fixture.mutations).toEqual([]);
    }).pipe(Effect.provide(fixture.layer));
  });
});

const input: ProjectCloneStartInput = {
  projectId: ProjectId.make("clone"),
  title: "repo",
  createdAt: at(0),
  remoteUrl: "https://host/repo",
  destinationPath: "/srv/repo",
};
const snapshot = (phase: ProjectCloneSnapshot["phase"]): ProjectCloneSnapshot => ({
  ...input,
  remoteUrl: input.remoteUrl!,
  repository: null,
  phase,
  stage: "connecting",
  percent: null,
  detail: null,
  error: phase === "failed" ? "Repository not found." : null,
  startedAt: at(0),
  endedAt: phase === "running" ? null : at(1),
  sequence: 1,
});
const cloneResult = {
  projectId: input.projectId,
  cwd: input.destinationPath,
  remoteUrl: input.remoteUrl!,
  repository: null,
};

describe("cloneProjectAndWait", () => {
  it.effect("waits through running events until the server reports completion", () =>
    Effect.gen(function* () {
      const result = yield* cloneProjectAndWait(
        {
          start: () => Effect.succeed(cloneResult),
          changes: Stream.make([snapshot("running")], [snapshot("done")]),
        },
        input,
      );
      expect(result).toEqual(cloneResult);
    }),
  );

  it.effect(
    "reports failed/cancelled clones and missing or disconnected completion without claiming readiness",
    () =>
      Effect.gen(function* () {
        for (const events of [[snapshot("failed")], [snapshot("cancelled")], []]) {
          const error = yield* Effect.flip(
            cloneProjectAndWait(
              {
                start: () => Effect.succeed(cloneResult),
                changes: Stream.make(events),
              },
              input,
            ),
          );
          expect(error.message).toContain(
            events[0]?.error ??
              (events[0]?.phase === "cancelled" ? "cancelled" : "could not be confirmed"),
          );
          expect(error.message).toContain(input.projectId);
        }
        const error = yield* Effect.flip(
          cloneProjectAndWait(
            {
              start: () => Effect.succeed(cloneResult),
              changes: Stream.empty,
            },
            input,
          ),
        );
        expect(error.message).toContain("could not be confirmed");
      }),
  );

  it.effect("preserves repository validation errors before a project is registered", () =>
    Effect.gen(function* () {
      const expected = new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider: "github",
        detail: "Repository not found.",
      });
      const error = yield* Effect.flip(
        cloneProjectAndWait(
          {
            start: () => Effect.fail(expected),
            changes: Stream.die("must not subscribe after rejection"),
          },
          input,
        ),
      );
      expect(error).toBe(expected);
    }),
  );
});
