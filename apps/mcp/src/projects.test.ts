import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProjectMutationError,
  SourceControlRepositoryError,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadLaunchInput,
  type ProjectCloneSnapshot,
  type ProjectCloneStartInput,
  type ProjectMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";

import { BridgeError, cloneProjectAndWait, projectCreationFailure } from "./environment.ts";
import {
  appThread,
  at,
  bridgeLayer,
  callTool as handle,
  fakeEnvironment,
  projection,
  run,
  serverConfig as config,
} from "./testing.ts";
import { BridgeToolkit } from "./tools.ts";

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
    "reports a clone that ends without a checkout as a registered project, never as ready",
    () =>
      Effect.gen(function* () {
        for (const [changes, code, reason] of [
          [Stream.make([snapshot("failed")]), "clone_failed", "Repository not found."],
          [Stream.make([snapshot("cancelled")]), "clone_failed", "was cancelled"],
          [Stream.make([]), "clone_unconfirmed", "may still be running"],
          [Stream.empty, "clone_unconfirmed", "may still be running"],
        ] as const) {
          const error = yield* Effect.flip(
            cloneProjectAndWait({ start: () => Effect.succeed(cloneResult), changes }, input),
          );
          expect(error).toMatchObject({ code, state: "registered" });
          expect(error.message).toContain(`${input.projectId} is registered at /srv/repo`);
          expect(error.message).toContain(reason);
        }
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

describe("projectCreationFailure", () => {
  const unconfirmed = "did not confirm";

  it("names the server's reason when it refused before registering anything", () => {
    // The server's own create and clone-start refusals, as they cross the wire.
    for (const [error, reason] of [
      [
        new ProjectMutationError({
          commandId: CommandId.make("command"),
          message: "Workspace /home/user/app already belongs to project existing.",
        }),
        "Workspace /home/user/app already belongs to project existing.",
      ],
      [
        new OrchestrationDispatchCommandError({
          message: "Workspace /home/user/app already belongs to project existing.",
        }),
        "Workspace /home/user/app already belongs to project existing.",
      ],
      [
        new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Destination path already exists and is not empty.",
        }),
        "Destination path already exists and is not empty.",
      ],
    ] as const) {
      const failure = projectCreationFailure("phobos", error, unconfirmed);
      expect(failure).toMatchObject({ code: "project_not_created", state: "not_created" });
      expect(failure.message).toContain('T3 server "phobos" did not create the project');
      expect(failure.message).toContain(reason);
    }
  });

  it("does not claim an outcome after a timeout or a dropped connection", () => {
    for (const error of [new Cause.TimeoutError(), new Error("socket closed")]) {
      expect(projectCreationFailure("phobos", error, unconfirmed)).toMatchObject({
        code: "project_unconfirmed",
        state: "unknown",
        message: unconfirmed,
      });
    }
  });
});
