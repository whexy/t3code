import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type RepositoryIdentity,
  type VcsListRefsInput,
  type VcsRef,
  type VcsStatusRemoteResult,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { BridgeError, Environments, type T3Environment, type VcsReads } from "./environment.ts";
import { redactRemoteUrl } from "./inspect.ts";
import { appThread, at, callTool, fakeEnvironment, serverConfig } from "./testing.ts";
import { BridgeToolkitHandlersLive } from "./tools.ts";

const isBridgeError = Schema.is(BridgeError);
const utc = (second: number) => DateTime.makeUnsafe(at(second));

const fork: RepositoryIdentity = {
  canonicalKey: "github.com/pingdotgg/t3code",
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "https://x-access-token:secret@github.com/pingdotgg/t3code.git",
  },
  displayName: "pingdotgg/t3code",
  provider: "github",
  owner: "pingdotgg",
  name: "t3code",
  origin: { canonicalKey: "github.com/whexy/t3code", displayName: "whexy/t3code" },
};
const upstream: RepositoryIdentity = {
  canonicalKey: "github.com/pingdotgg/t3code",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:pingdotgg/t3code.git",
  },
  displayName: "pingdotgg/t3code",
  name: "t3code",
};
const acmeApp: RepositoryIdentity = {
  canonicalKey: "github.com/acme/app",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://github.com/acme/app" },
  displayName: "acme/app",
  name: "app",
};

const project = (
  id: string,
  title: string,
  workspaceRoot: string,
  repositoryIdentity: RepositoryIdentity | null,
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot,
  repositoryIdentity,
  defaultModelSelection: null,
  scripts: [],
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
});

function session(
  id: string,
  projectId: string,
  worktreePath: string | null,
  status: "running" | "completed",
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const thread = appThread({
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: `Session ${id}`,
    worktreePath,
  });
  return {
    ...thread,
    latestRunId: RunId.make(`${id}-run`),
    latestRunRequestedAt: utc(1),
    latestRunStartedAt: utc(2),
    latestRunCompletedAt: status === "running" ? null : utc(5),
    activeRunId: status === "running" ? RunId.make(`${id}-run`) : null,
    ...(status === "running" ? { activityRunStatus: "running" as const } : {}),
    status,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: utc(1),
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 2,
    visibleItemCount: 2,
    updatedAt: utc(5),
    ...overrides,
  };
}

const shell = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationV2ThreadShell> = [],
): OrchestrationV2ShellSnapshot => ({
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [...projects],
  threads: [...threads],
  archivedThreads: [],
});

/** Inspection reads nothing else; any other call dies via fakeEnvironment. */
const server = (
  id: string,
  snapshot: OrchestrationV2ShellSnapshot | BridgeError,
  overrides: Partial<T3Environment> = {},
) =>
  fakeEnvironment({
    id,
    name: id.toUpperCase(),
    shell: isBridgeError(snapshot) ? Effect.fail(snapshot) : Effect.succeed(snapshot),
    ...overrides,
  });

function bridge(...environments: ReadonlyArray<T3Environment>) {
  return BridgeToolkitHandlersLive.pipe(
    Layer.provide(
      Layer.succeed(
        Environments,
        Environments.of({
          enabled: Effect.succeed(environments),
          get: (id) => {
            const found = environments.find((environment) => environment.id === id);
            return found === undefined
              ? Effect.fail(new BridgeError({ message: `Unknown server_id "${id}".` }))
              : Effect.succeed(found);
          },
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
}

const homeFork = project("home-fork", "t3code", "/home/u/t3code", fork);
const homeApp = project("home-app", "app", "/home/u/app", null);
const homeScratch = project("home-scratch", "t3code-work", "/home/u/scratch", null);
const workFork = project("work-fork", "t3code-work", "/srv/t3code", fork);
const workUpstream = project("work-upstream", "pingdotgg", "/srv/upstream", upstream);
const workApp = project("work-app", "app", "/srv/app", acmeApp);
const federation = () =>
  bridge(
    server("home", shell([homeFork, homeApp, homeScratch])),
    server("work", shell([workFork, workUpstream, workApp])),
  );
const ids = (instances: ReadonlyArray<{ server_id: string; project_id: string }>) =>
  instances.map((instance) => `${instance.server_id}/${instance.project_id}`);

describe("inspect_project selection", () => {
  it.effect("groups a repository's instances across servers, keeping each server's ids", () =>
    Effect.gen(function* () {
      const result = yield* callTool("inspect_project", {
        server_id: "home",
        project_id: "home-fork",
        sections: [],
      });
      expect(result.status).toBe("resolved");
      expect(result.key).toBe("github.com/whexy/t3code");
      // The upstream clone shares the canonical key but is a different project.
      expect(ids(result.instances)).toEqual(["home/home-fork", "work/work-fork"]);
      expect(result.instances.map((instance) => [instance.selected, instance.path])).toEqual([
        [true, "/home/u/t3code"],
        [false, "/srv/t3code"],
      ]);
      expect(result.instances[0]!.repository).toEqual({
        status: "identified",
        key: "github.com/whexy/t3code",
        canonical_key: "github.com/pingdotgg/t3code",
        display_name: "whexy/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
        remote: { name: "upstream", url: "https://github.com/pingdotgg/t3code.git" },
      });

      const alone = yield* callTool("inspect_project", {
        server_id: "home",
        project_id: "home-fork",
        include_related: false,
        sections: [],
      });
      expect(ids(alone.instances)).toEqual(["home/home-fork"]);
    }).pipe(Effect.provide(federation())),
  );

  it.effect("returns identity alone for an unidentified project when no sections are asked", () =>
    Effect.gen(function* () {
      for (const [server_id, project_id] of [
        ["home", "home-app"],
        ["work", "work-dotfiles"],
      ] as const) {
        const result = yield* callTool("inspect_project", { server_id, project_id, sections: [] });
        expect(ids(result.instances)).toEqual([`${server_id}/${project_id}`]);
        expect(Object.keys(result.instances[0]!).toSorted()).toEqual([
          "name",
          "path",
          "project_id",
          "repository",
          "selected",
          "server_id",
          "server_name",
        ]);
        expect(result.instances[0]!.repository).toEqual({ status: "unidentified", key: null });
      }
    }).pipe(
      Effect.provide(
        bridge(
          server("home", shell([homeApp])),
          server("work", shell([project("work-dotfiles", "dotfiles", "/srv/dotfiles", null)])),
        ),
      ),
    ),
  );

  it.effect("matches a repository by its own key before a fork's upstream", () =>
    Effect.gen(function* () {
      const upstreamOnly = yield* callTool("inspect_project", {
        repository: "https://github.com/pingdotgg/t3code.git",
        sections: [],
      });
      expect(ids(upstreamOnly.instances)).toEqual(["work/work-upstream"]);

      const forkByPath = yield* callTool("inspect_project", {
        repository: "whexy/t3code",
        sections: [],
      });
      expect(forkByPath.matched_by).toBe("repository");
      expect(ids(forkByPath.instances)).toEqual(["home/home-fork", "work/work-fork"]);
    }).pipe(Effect.provide(federation())),
  );

  it.effect("reports an ambiguous name with candidates instead of inspecting", () =>
    Effect.gen(function* () {
      // Matches the fork's and the upstream's repository name; readVcs would die if called.
      const result = yield* callTool("inspect_project", { name: "T3Code" });
      expect(result.status).toBe("ambiguous");
      expect(result.instances).toEqual([]);
      expect(result.candidates).toEqual([
        {
          key: "github.com/whexy/t3code",
          name: "whexy/t3code",
          instances: [
            { server_id: "home", project_id: "home-fork", name: "t3code", path: "/home/u/t3code" },
            {
              server_id: "work",
              project_id: "work-fork",
              name: "t3code-work",
              path: "/srv/t3code",
            },
          ],
        },
        {
          key: "github.com/pingdotgg/t3code",
          name: "pingdotgg/t3code",
          instances: [
            {
              server_id: "work",
              project_id: "work-upstream",
              name: "pingdotgg",
              path: "/srv/upstream",
            },
          ],
        },
      ]);
    }).pipe(Effect.provide(federation())),
  );

  it.effect("never groups by name, and server_id narrows a name match", () =>
    Effect.gen(function* () {
      // Only work's checkout carries this title, yet the fork's candidate lists all its instances.
      const sharedTitle = yield* callTool("inspect_project", { name: "t3code-work" });
      expect(
        sharedTitle.candidates.map((candidate) => [candidate.key, ids(candidate.instances)]),
      ).toEqual([
        [null, ["home/home-scratch"]],
        ["github.com/whexy/t3code", ["home/home-fork", "work/work-fork"]],
      ]);

      const both = yield* callTool("inspect_project", { name: "app", sections: [] });
      expect(both.status).toBe("ambiguous");
      expect(both.candidates.map((candidate) => candidate.key)).toEqual([
        null,
        "github.com/acme/app",
      ]);

      const work = yield* callTool("inspect_project", {
        name: "app",
        server_id: "work",
        sections: [],
      });
      expect(work.status).toBe("resolved");
      expect(ids(work.instances)).toEqual(["work/work-app"]);

      const home = yield* callTool("inspect_project", {
        name: "app",
        server_id: "home",
        sections: [],
      });
      expect(home.key).toBeNull();
      expect(home.instances[0]!.repository).toEqual({ status: "unidentified", key: null });
    }).pipe(Effect.provide(federation())),
  );

  it.effect("inspects reachable servers and names the unreachable ones", () =>
    Effect.gen(function* () {
      const layer = bridge(
        server("home", shell([homeFork])),
        server("work", new BridgeError({ message: 'T3 server "work" is unreachable.' })),
      );
      const result = yield* callTool("inspect_project", {
        server_id: "home",
        project_id: "home-fork",
        sections: [],
      }).pipe(Effect.provide(layer));
      expect(ids(result.instances)).toEqual(["home/home-fork"]);
      expect(result.servers).toEqual([
        { server_id: "home", name: "HOME" },
        { server_id: "work", name: "WORK", error: 'T3 server "work" is unreachable.' },
      ]);

      const missing = yield* callTool("inspect_project", { repository: "acme/app" }).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      expect(missing).toMatchObject({ code: "project_not_found" });
      expect(missing.message).toContain('Not searched: work (T3 server "work" is unreachable.)');
    }),
  );

  it.effect("rejects selectors that do not name exactly one thing", () =>
    Effect.gen(function* () {
      const message = (input: Parameters<typeof callTool<"inspect_project">>[1]) =>
        callTool("inspect_project", input).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      expect(yield* message({ name: "app", repository: "acme/app" })).toContain("exactly one");
      expect(yield* message({})).toContain("exactly one");
      expect(yield* message({ project_id: "home-fork" })).toContain("requires its server_id");
      expect(yield* message({ name: "app", include_related: true })).toContain(
        "only to project_id",
      );
    }).pipe(Effect.provide(federation())),
  );
});

const ref = (name: string, overrides: Partial<VcsRef> = {}): VcsRef => ({
  name,
  current: false,
  isDefault: false,
  worktreePath: null,
  ...overrides,
});
const remoteRef = (name: string, isDefault = false): VcsRef => ({
  ...ref(name, { isDefault }),
  isRemote: true,
  remoteName: name.split("/")[0]!,
});

const localRefs = [
  ref("main", { current: true, isDefault: true, worktreePath: "/home/u/t3code" }),
  ref("feature/a", { worktreePath: "/home/u/.t3/worktrees/a" }),
  ref("feature/b"),
  ref("feature/nested", { worktreePath: "/home/u/t3code/.worktrees/nested" }),
];
const remoteRefs = [
  remoteRef("origin/main", true),
  remoteRef("origin/feature/a"),
  remoteRef("upstream/main"),
  remoteRef("origin/gone"),
];

const status = (refName: string, remote: VcsStatusRemoteResult | null) => ({
  local: {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: refName === "main",
    refName,
    hasWorkingTreeChanges: refName === "main",
    workingTree: {
      files:
        refName === "main"
          ? [
              { path: "a.ts", insertions: 3, deletions: 1 },
              { path: "b.ts", insertions: 2, deletions: 0 },
            ]
          : [],
      insertions: refName === "main" ? 5 : 0,
      deletions: refName === "main" ? 1 : 0,
    },
  },
  remote,
});

/** A server whose Git reads answer from paged refs and per-checkout statuses. */
function gitServer(
  refs: { local: ReadonlyArray<VcsRef>; remote: ReadonlyArray<VcsRef> } | "not_git",
  inspected: OrchestrationProjectShell = homeFork,
) {
  const listed: Array<VcsListRefsInput> = [];
  const statuses: Array<string> = [];
  const reads: VcsReads = {
    listRefs: (input) =>
      Effect.sync(() => {
        listed.push(input);
        if (refs === "not_git") {
          return {
            refs: [],
            isRepo: false,
            hasPrimaryRemote: false,
            nextCursor: null,
            totalCount: 0,
          };
        }
        const all = input.refKind === "remote" ? refs.remote : refs.local;
        // Two refs per page, so inspection has to follow cursors.
        const cursor = input.cursor ?? 0;
        const next = cursor + 2;
        return {
          refs: all.slice(cursor, next),
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: next < all.length ? next : null,
          totalCount: all.length,
        };
      }),
    status: (cwd) =>
      Effect.suspend(() => {
        statuses.push(cwd);
        switch (cwd) {
          case "/home/u/t3code":
            return Effect.succeed(
              status("main", { hasUpstream: true, aheadCount: 1, behindCount: 0, pr: null }),
            );
          case "/home/u/.t3/worktrees/a":
            return Effect.succeed(status("feature/a", null));
          default:
            return Effect.fail(new BridgeError({ message: `No status for ${cwd}.` }));
        }
      }),
  };
  const environment = server(
    "home",
    shell(
      [inspected],
      [
        session("main-run", "home-fork", null, "running"),
        session("a-done", "home-fork", "/home/u/.t3/worktrees/a", "completed"),
        session("nested-run", "home-fork", "/home/u/t3code/.worktrees/nested", "running"),
        session("a-sub", "home-fork", "/home/u/.t3/worktrees/a", "running", {
          lineage: {
            parentThreadId: ThreadId.make("a-done"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("a-done"),
          },
        }),
      ],
    ),
    {
      // The real wrapper turns authorization refusals into a BridgeError too.
      readVcs: (use) =>
        use(reads).pipe(
          Effect.mapError((error) =>
            isBridgeError(error) ? error : new BridgeError({ message: error.message }),
          ),
        ),
      serverConfig: Effect.succeed(serverConfig),
    },
  );
  return { listed, statuses, layer: bridge(environment) };
}

const select = { server_id: "home", project_id: "home-fork" } as const;

describe("inspect_project details", () => {
  it.effect("reports the checkout, branches, and worktrees with the sessions using them", () => {
    const git = gitServer({ local: localRefs, remote: remoteRefs });
    return Effect.gen(function* () {
      const result = yield* callTool("inspect_project", {
        ...select,
        sections: ["checkout", "branches", "worktrees"],
      });
      const instance = result.instances[0]!;
      expect(instance.settings).toBeUndefined();
      expect(instance.checkout).toEqual({
        branch: "main",
        is_default_branch: true,
        dirty: true,
        changed_files: 2,
        insertions: 5,
        deletions: 1,
        upstream: "tracking",
        ahead: 1,
        behind: 0,
        pull_request: null,
      });

      const branches = instance.branches!;
      expect([branches.current, branches.default, branches.remotes]).toEqual([
        "main",
        "main",
        ["origin", "upstream"],
      ]);
      expect(branches.local.items).toEqual([
        {
          name: "main",
          current: true,
          default: true,
          checked_out_at: "/home/u/t3code",
          remote_branches: ["origin/main", "upstream/main"],
          session_checkouts: ["local"],
        },
        {
          name: "feature/a",
          current: false,
          default: false,
          checked_out_at: "/home/u/.t3/worktrees/a",
          remote_branches: ["origin/feature/a"],
          session_checkouts: ["existing_worktree"],
        },
        {
          name: "feature/b",
          current: false,
          default: false,
          checked_out_at: null,
          remote_branches: [],
          session_checkouts: ["local"],
        },
        {
          name: "feature/nested",
          current: false,
          default: false,
          checked_out_at: "/home/u/t3code/.worktrees/nested",
          remote_branches: [],
          session_checkouts: ["existing_worktree"],
        },
      ]);
      expect(branches.remote.items.map((item) => [item.name, item.local_branch])).toEqual([
        ["origin/main", true],
        ["origin/feature/a", true],
        ["upstream/main", true],
        ["origin/gone", false],
      ]);

      // The nested worktree keeps its own session, and the busier worktree lists first.
      expect(
        instance.worktrees!.items.map((item) => [
          item.path,
          item.branch,
          item.project_checkout,
          item.sessions.recent.map((recent) => recent.session_id),
          item.sessions.active,
          item.status?.upstream ?? item.status_error,
        ]),
      ).toEqual([
        ["/home/u/t3code", "main", true, ["main-run"], 1, "tracking"],
        [
          "/home/u/t3code/.worktrees/nested",
          "feature/nested",
          false,
          ["nested-run"],
          1,
          "No status for /home/u/t3code/.worktrees/nested.",
        ],
        ["/home/u/.t3/worktrees/a", "feature/a", false, ["a-done"], 0, "unknown"],
      ]);
      expect(instance.worktrees!.total).toBe(3);

      // Only the two read-only calls; every ref page followed, no fetch-triggering status refresh.
      expect(git.listed.map((input) => [input.refKind, input.cursor ?? 0])).toEqual([
        ["local", 0],
        ["local", 2],
        ["remote", 0],
        ["remote", 2],
      ]);
      expect(
        git.listed.find((input) => input.refKind === "remote")?.includeMatchingRemoteRefs,
      ).toBe(true);
    }).pipe(Effect.provide(git.layer));
  });

  it.effect("filters and pages branch lists and bounds worktrees", () => {
    const git = gitServer({ local: localRefs, remote: remoteRefs });
    return Effect.gen(function* () {
      const first = yield* callTool("inspect_project", {
        ...select,
        sections: ["branches", "worktrees"],
        branch_query: "FEATURE",
        branch_limit: 1,
        worktree_limit: 2,
      });
      const branches = first.instances[0]!.branches!;
      expect(branches.local).toMatchObject({ total: 3, next_offset: 1 });
      expect(branches.local.items.map((item) => item.name)).toEqual(["feature/a"]);
      expect(branches.remote).toMatchObject({ total: 1, next_offset: null });
      expect(first.instances[0]!.worktrees).toMatchObject({ total: 3, more: 1 });
      expect(first.instances[0]!.worktrees!.items).toHaveLength(2);

      const second = yield* callTool("inspect_project", {
        ...select,
        sections: ["branches"],
        branch_query: "feature",
        branch_limit: 1,
        branch_offset: 1,
      });
      expect(second.instances[0]!.branches!.local.items.map((item) => item.name)).toEqual([
        "feature/b",
      ]);
      expect(second.instances[0]!.branches!.local.next_offset).toBe(2);
    }).pipe(Effect.provide(git.layer));
  });

  it.effect("reports a folder outside Git without reading status", () => {
    const git = gitServer("not_git", project("home-fork", "notes", "/home/u/notes", null));
    return Effect.gen(function* () {
      const result = yield* callTool("inspect_project", {
        ...select,
        sections: ["checkout", "branches"],
      });
      const instance = result.instances[0]!;
      expect(instance.repository).toEqual({ status: "not_git", key: null });
      expect([instance.checkout, instance.branches, instance.worktrees]).toEqual([
        null,
        null,
        undefined,
      ]);
      expect(git.statuses).toEqual([]);
    }).pipe(Effect.provide(git.layer));
  });

  it.effect("reports settings without touching Git", () =>
    Effect.gen(function* () {
      const scripted = project("home-fork", "t3code", "/home/u/t3code", null, {
        autoPull: true,
        scripts: [
          {
            id: "setup",
            name: "Setup",
            command: "vp i",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
      });
      const layer = bridge(
        server("home", shell([scripted]), { serverConfig: Effect.succeed(serverConfig) }),
      );
      const result = yield* callTool("inspect_project", {
        ...select,
        sections: ["settings"],
      }).pipe(Effect.provide(layer));
      expect(result.instances[0]!.settings).toEqual({
        default_agent: "codex",
        default_model: "gpt-5.5",
        default_reasoning_effort: null,
        runtime_mode: "full-access",
        new_session_checkout: null,
        new_worktrees_start_from_origin: true,
        auto_pull: true,
        branch_name_prefix: "t3",
        scripts: [{ name: "Setup", runs_on_worktree_create: true }],
        project_overrides: [],
      });
      expect(result.instances[0]!.checkout).toBeUndefined();
    }),
  );
});

describe("redactRemoteUrl", () => {
  it("drops credentials from URL remotes and leaves SCP-style remotes", () => {
    expect(redactRemoteUrl("https://user:token@example.com/a/b.git")).toBe(
      "https://example.com/a/b.git",
    );
    expect(redactRemoteUrl("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
    expect(redactRemoteUrl("https://github.com/a/b")).toBe("https://github.com/a/b");
  });
});
