import {
  TrimmedNonEmptyString,
  repositoryGroupingDisplayNameOf,
  repositoryGroupingKeyOf,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type ServerConfig,
  type VcsListRefsResult,
  type VcsRef,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";

import { resolveModelSelection, selectedReasoningEffort } from "./agents.ts";
import {
  BridgeError,
  type Environments,
  type T3Environment,
  type VcsReads,
} from "./environment.ts";
import { presentSession } from "./sessions.ts";

const DEFAULT_BRANCH_LIMIT = 10;
const DEFAULT_WORKTREE_LIMIT = 10;
const MAX_INSTANCES = 20;
const RECENT_SESSIONS = 3;
/** Ref scans stop at 2,000 refs of each kind; larger repositories report truncated. */
const REF_PAGE_SIZE = 200;
const MAX_REF_PAGES = 10;
const STATUS_CONCURRENCY = 4;

const optional = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));
const text = (description: string) =>
  Schema.String.annotate({ description }).pipe(Schema.decodeTo(TrimmedNonEmptyString));
const limit = (description: string) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({ description });

const Section = Schema.Literals(["settings", "checkout", "branches", "worktrees"]);
type Section = typeof Section.Type;
const ALL_SECTIONS: ReadonlyArray<Section> = ["settings", "checkout", "branches", "worktrees"];

const Parameters = Schema.Struct({
  server_id: optional(
    text(
      "server_id from list_projects. Required with project_id. With repository or name, only instances on this server are matched and inspected.",
    ),
  ),
  project_id: optional(
    text(
      "project_id from list_projects: selects that instance on server_id, plus every other instance of the same repository unless include_related is false.",
    ),
  ),
  repository: optional(
    text(
      "A repository: a Git remote or web URL, a key such as github.com/owner/repo, or owner/repo.",
    ),
  ),
  name: optional(
    text(
      "A project or repository name, matched whole and ignoring case. Instances are grouped by repository, never by name.",
    ),
  ),
  include_related: optional(
    Schema.Boolean.annotate({
      description:
        "Only with project_id: also inspect other instances of its repository on every server. Default true.",
    }),
  ),
  sections: optional(
    Schema.Array(Section).annotate({
      description:
        "Details per instance; default all. settings: default agent, model and session settings. checkout: the project checkout's branch, changes, and upstream. branches: local and remote branches. worktrees: checkouts and the sessions using them. An empty list returns identity only.",
    }),
  ),
  branch_query: optional(
    Schema.String.annotate({
      description: "Only list branches whose name contains this text, ignoring case.",
    }),
  ),
  branch_limit: optional(
    limit(`Local and remote branches to list per instance (default ${DEFAULT_BRANCH_LIMIT}).`),
  ),
  branch_offset: optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Branches to skip in each list. Pass a list's next_offset to page.",
    }),
  ),
  worktree_limit: optional(
    limit(
      `Worktrees to list per instance, project checkout first (default ${DEFAULT_WORKTREE_LIMIT}).`,
    ),
  ),
});
type Input = typeof Parameters.Type;

const CheckoutStatus = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  is_default_branch: Schema.Boolean,
  dirty: Schema.Boolean,
  changed_files: Schema.Int,
  insertions: Schema.Int,
  deletions: Schema.Int,
  upstream: Schema.Literals(["tracking", "none", "unknown"]),
  ahead: Schema.NullOr(Schema.Int),
  behind: Schema.NullOr(Schema.Int),
  pull_request: Schema.NullOr(
    Schema.Struct({
      number: Schema.Int,
      title: Schema.String,
      url: Schema.String,
      state: Schema.String,
    }),
  ),
});
type CheckoutStatus = typeof CheckoutStatus.Type;

const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    total: Schema.Int,
    next_offset: Schema.NullOr(Schema.Int),
    items: Schema.Array(item),
  });

const Branches = Schema.Struct({
  current: Schema.NullOr(Schema.String),
  default: Schema.NullOr(Schema.String),
  remotes: Schema.Array(Schema.String),
  local: Page(
    Schema.Struct({
      name: Schema.String,
      current: Schema.Boolean,
      default: Schema.Boolean,
      checked_out_at: Schema.NullOr(Schema.String),
      remote_branches: Schema.Array(Schema.String),
      session_checkouts: Schema.Array(Schema.Literals(["local", "existing_worktree"])),
    }),
  ),
  remote: Page(
    Schema.Struct({
      name: Schema.String,
      remote: Schema.NullOr(Schema.String),
      default: Schema.Boolean,
      local_branch: Schema.Boolean,
    }),
  ),
  truncated: Schema.optionalKey(Schema.Literal(true)),
});
type Branches = typeof Branches.Type;

const Sessions = Schema.Struct({
  total: Schema.Int,
  active: Schema.Int,
  recent: Schema.Array(
    Schema.Struct({
      session_id: Schema.String,
      title: Schema.String,
      state: Schema.String,
      updated_at: Schema.String,
    }),
  ),
});
type Sessions = typeof Sessions.Type;

const Worktrees = Schema.Struct({
  total: Schema.Int,
  more: Schema.Int,
  items: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      branch: Schema.NullOr(Schema.String),
      project_checkout: Schema.Boolean,
      status: Schema.NullOr(CheckoutStatus),
      status_error: Schema.optionalKey(Schema.String),
      sessions: Sessions,
    }),
  ),
  truncated: Schema.optionalKey(Schema.Literal(true)),
});
type Worktrees = typeof Worktrees.Type;

const Repository = Schema.Struct({
  status: Schema.Literals(["identified", "unidentified", "no_remote", "not_git"]),
  key: Schema.NullOr(Schema.String),
  canonical_key: Schema.optionalKey(Schema.String),
  display_name: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  web_url: Schema.optionalKey(Schema.String),
  remote: Schema.optionalKey(Schema.Struct({ name: Schema.String, url: Schema.String })),
  root_path: Schema.optionalKey(Schema.String),
});
type Repository = typeof Repository.Type;

const Settings = Schema.Struct({
  default_agent: Schema.NullOr(Schema.String),
  default_model: Schema.NullOr(Schema.String),
  default_reasoning_effort: Schema.NullOr(Schema.String),
  runtime_mode: Schema.String,
  new_session_checkout: Schema.NullOr(Schema.Literals(["local", "worktree"])),
  new_worktrees_start_from_origin: Schema.Boolean,
  auto_pull: Schema.Boolean,
  branch_name_prefix: Schema.String,
  scripts: Schema.Array(
    Schema.Struct({ name: Schema.String, runs_on_worktree_create: Schema.Boolean }),
  ),
  project_overrides: Schema.Array(Schema.String),
});
type Settings = typeof Settings.Type;

const InstanceRef = Schema.Struct({
  server_id: Schema.String,
  project_id: Schema.String,
  name: Schema.String,
  path: Schema.String,
});

const Instance = Schema.Struct({
  ...InstanceRef.fields,
  server_name: Schema.String,
  selected: Schema.Boolean,
  repository: Repository,
  settings: Schema.optionalKey(Schema.NullOr(Settings)),
  checkout: Schema.optionalKey(Schema.NullOr(CheckoutStatus)),
  branches: Schema.optionalKey(Schema.NullOr(Branches)),
  worktrees: Schema.optionalKey(Schema.NullOr(Worktrees)),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
});
type Instance = typeof Instance.Type;

const Success = Schema.Struct({
  status: Schema.Literals(["resolved", "ambiguous"]),
  matched_by: Schema.Literals(["project_id", "repository", "name"]),
  key: Schema.NullOr(Schema.String),
  servers: Schema.Array(
    Schema.Struct({
      server_id: Schema.String,
      name: Schema.String,
      error: Schema.optionalKey(Schema.String),
    }),
  ),
  instances: Schema.Array(Instance),
  more_instances: Schema.Int,
  candidates: Schema.Array(
    Schema.Struct({
      key: Schema.NullOr(Schema.String),
      name: Schema.String,
      instances: Schema.Array(InstanceRef),
    }),
  ),
});

export const InspectProjectTool = Tool.make("inspect_project", {
  description:
    "Inspect one logical project across every T3 server where it is registered, before choosing a checkout for create_session. Select with exactly one of project_id (with server_id), repository, or name. Instances are grouped by repository identity from Git remotes (key), the same grouping T3 Code uses; a fork is a separate project from its upstream, and projects are never grouped by name. A project without an identified repository stands alone. If name or repository matches more than one logical project, status is ambiguous: nothing is inspected, and candidates lists each one with its instances. Ask the user which one, or call again with project_id. When resolved, each instance keeps its own server_id, project_id, and path; pass that instance's ids to create_session, since ids and paths differ per server. repository.status is identified, not_git, no_remote, or unidentified (no identity reported; the server may still be resolving it, so retry shortly). checkout is the project checkout's branch, uncommitted changes, and upstream: tracking with ahead/behind, none, or unknown when the server has not checked the remote recently. Nothing here fetches, so remote state can be stale. branches lists local branches (checked_out_at is the worktree holding one; session_checkouts names the create_session checkout modes that accept it as branch; remote_branches are same-named remote branches, not necessarily the configured upstream) and remote branches (local_branch says whether a local branch of that name exists). Any listed branch can be a worktree base_branch. worktrees lists checkouts, the project checkout first, with their status and the sessions using them (active counts queued, starting, running, and waiting). Worktrees with a detached HEAD are not listed. Use sections, branch_query, branch_limit, branch_offset, and worktree_limit to keep results small. Read-only: no file contents, Git fetches, or changes. An unreachable server is reported in servers while the others are inspected.",
  parameters: Parameters,
  success: Success,
  failure: BridgeError,
})
  .annotate(Tool.Title, "Inspect a T3 Code project")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

interface Entry {
  readonly environment: T3Environment;
  readonly shell: OrchestrationV2ShellSnapshot;
  readonly project: OrchestrationProjectShell;
}

const keyOf = (project: OrchestrationProjectShell) =>
  project.repositoryIdentity == null ? null : repositoryGroupingKeyOf(project.repositoryIdentity);

/** Unidentified projects never share a group: a name says nothing about the repository. */
const groupOf = (entry: Entry) =>
  keyOf(entry.project) ?? `${entry.environment.id}\u0000${entry.project.id}`;

/** owner/repo from github.com/owner/repo. */
const repositoryPath = (key: string) => key.split("/").slice(1).join("/");

const matchesRepository = (key: string, query: string) =>
  key === query || repositoryPath(key) === query;

function nameMatches(project: OrchestrationProjectShell, name: string) {
  const wanted = name.toLowerCase();
  const identity = project.repositoryIdentity;
  return [
    project.title,
    identity?.name,
    identity?.displayName,
    identity == null ? undefined : repositoryGroupingDisplayNameOf(identity),
  ].some((candidate) => candidate?.toLowerCase() === wanted);
}

function groupEntries(entries: ReadonlyArray<Entry>) {
  const groups = new Map<string, Array<Entry>>();
  for (const entry of entries) {
    const group = groupOf(entry);
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  return [...groups.values()];
}

type Selection =
  | {
      readonly status: "resolved";
      readonly key: string | null;
      readonly entries: ReadonlyArray<Entry>;
      readonly selected: Entry | undefined;
    }
  | { readonly status: "ambiguous"; readonly groups: ReadonlyArray<ReadonlyArray<Entry>> }
  | { readonly status: "not_found"; readonly message: string };

/**
 * Which instances a selector names. A matched group with a repository key
 * expands to every instance of that repository among `entries`, so a name that
 * matches one checkout's title still finds the same repository elsewhere.
 */
function selectInstances(
  entries: ReadonlyArray<Entry>,
  input: Pick<Input, "server_id" | "project_id" | "repository" | "name" | "include_related">,
): Selection {
  const sameKey = (key: string) => entries.filter((entry) => keyOf(entry.project) === key);
  const resolve = (groups: ReadonlyArray<ReadonlyArray<Entry>>): Selection => {
    const expanded = groups.map((group) => {
      const key = keyOf(group[0]!.project);
      return { key, entries: key === null ? group : sameKey(key) };
    });
    if (expanded.length > 1) {
      return { status: "ambiguous", groups: expanded.map((group) => group.entries) };
    }
    return {
      status: "resolved",
      key: expanded[0]!.key,
      entries: expanded[0]!.entries,
      selected: undefined,
    };
  };

  if (input.project_id != null) {
    const selected = entries.find(
      (entry) => entry.environment.id === input.server_id && entry.project.id === input.project_id,
    );
    if (selected === undefined) {
      return {
        status: "not_found",
        message: `Project ${input.project_id} is not registered on server "${input.server_id}".`,
      };
    }
    const key = keyOf(selected.project);
    return {
      status: "resolved",
      key,
      entries: key === null || input.include_related === false ? [selected] : sameKey(key),
      selected,
    };
  }

  if (input.repository != null) {
    const query = normalizeGitRemoteUrl(input.repository);
    const byKey = entries.filter((entry) => {
      const key = keyOf(entry.project);
      return key !== null && matchesRepository(key, query);
    });
    // A fork's key is its own remote; its canonical key is the upstream it tracks.
    const matched =
      byKey.length > 0
        ? byKey
        : entries.filter((entry) => {
            const canonical = entry.project.repositoryIdentity?.canonicalKey;
            return canonical !== undefined && matchesRepository(canonical, query);
          });
    return matched.length === 0
      ? {
          status: "not_found",
          message: `No project with repository "${input.repository}" is registered on the searched servers.`,
        }
      : resolve(groupEntries(matched));
  }

  const name = input.name!;
  const matched = entries.filter((entry) => nameMatches(entry.project, name));
  return matched.length === 0
    ? {
        status: "not_found",
        message: `No project named "${name}" is registered on the searched servers.`,
      }
    : resolve(groupEntries(matched));
}

/** Credentials in an HTTPS remote URL stay on the server. */
export function redactRemoteUrl(url: string) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "") return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function presentRepository(
  project: OrchestrationProjectShell,
  git: { readonly isRepo: boolean; readonly hasRemote: boolean | undefined } | undefined,
): Repository {
  const identity = project.repositoryIdentity;
  if (identity == null) {
    if (git?.isRepo === false) return { status: "not_git", key: null };
    if (git?.hasRemote === false) return { status: "no_remote", key: null };
    return { status: "unidentified", key: null };
  }
  const displayName = repositoryGroupingDisplayNameOf(identity);
  return {
    status: "identified",
    key: repositoryGroupingKeyOf(identity),
    canonical_key: identity.canonicalKey,
    ...(displayName === undefined ? {} : { display_name: displayName }),
    ...(identity.provider === undefined ? {} : { provider: identity.provider }),
    ...(identity.owner === undefined ? {} : { owner: identity.owner }),
    ...(identity.name === undefined ? {} : { name: identity.name }),
    ...(identity.webUrl === undefined ? {} : { web_url: identity.webUrl }),
    remote: {
      name: identity.locator.remoteName,
      url: redactRemoteUrl(identity.locator.remoteUrl),
    },
    ...(identity.rootPath === undefined ? {} : { root_path: identity.rootPath }),
  };
}

function presentSettings(config: ServerConfig, project: OrchestrationProjectShell): Settings {
  const resolved = resolveProjectSettings(config.settings, project.id, project);
  const settings = resolved.settings;
  const selection = resolveModelSelection({
    providers: config.providers,
    projectDefault: settings.defaultModelSelection,
  });
  const model = Result.isSuccess(selection) ? selection.success : null;
  return {
    default_agent: model?.instanceId ?? null,
    default_model: model?.model ?? null,
    default_reasoning_effort: model === null ? null : selectedReasoningEffort(model),
    runtime_mode: settings.defaultRuntimeMode,
    // Null defers to the repository's t3.json, then local.
    new_session_checkout: settings.defaultThreadEnvMode ?? null,
    new_worktrees_start_from_origin: settings.newWorktreesStartFromOrigin,
    auto_pull: project.autoPull === true,
    branch_name_prefix: settings.branchNamePrefix,
    scripts: project.scripts.map((script) => ({
      name: script.name,
      runs_on_worktree_create: script.runOnWorktreeCreate,
    })),
    project_overrides: Object.entries(resolved.sources)
      .filter(([, source]) => source === "project")
      .map(([key]) => key)
      .toSorted(),
  };
}

function presentStatus(status: Effect.Success<ReturnType<VcsReads["status"]>>): CheckoutStatus {
  const { local, remote } = status;
  const tracking = remote?.hasUpstream === true;
  return {
    branch: local.refName,
    is_default_branch: local.isDefaultRef,
    dirty: local.hasWorkingTreeChanges,
    changed_files: local.workingTree.files.length,
    insertions: local.workingTree.insertions,
    deletions: local.workingTree.deletions,
    upstream: remote === null ? "unknown" : tracking ? "tracking" : "none",
    ahead: tracking ? remote.aheadCount : null,
    behind: tracking ? remote.behindCount : null,
    pull_request:
      remote?.pr == null
        ? null
        : {
            number: remote.pr.number,
            title: remote.pr.title,
            url: remote.pr.url,
            state: remote.pr.state,
          },
  };
}

const trimPath = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, "") : path);

const within = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);

const ACTIVE_STATES = new Set(["queued", "starting", "running", "waiting"]);

/**
 * Sessions by the checkout they run in: the thread's worktree, else its
 * project's root, assigned to the deepest checkout containing it so a worktree
 * nested inside the main checkout keeps its own sessions.
 */
function sessionsByCheckout(
  serverId: string,
  shell: OrchestrationV2ShellSnapshot,
  checkoutPaths: ReadonlyArray<string>,
) {
  const roots = new Map(shell.projects.map((project) => [project.id, project]));
  const paths = checkoutPaths.map(trimPath).toSorted((left, right) => right.length - left.length);
  const byPath = new Map<string, Array<ReturnType<typeof presentSession>>>();
  for (const thread of shell.threads) {
    if (thread.lineage.relationshipToParent === "subagent") continue;
    const project = roots.get(thread.projectId);
    const cwd = thread.worktreePath ?? project?.workspaceRoot;
    if (cwd === undefined) continue;
    const owner = paths.find((path) => within(trimPath(cwd), path));
    if (owner === undefined) continue;
    byPath.set(owner, [
      ...(byPath.get(owner) ?? []),
      presentSession(serverId, thread, project?.title ?? thread.projectId),
    ]);
  }
  return (path: string): Sessions => {
    const sessions = (byPath.get(trimPath(path)) ?? []).toSorted(
      (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at),
    );
    return {
      total: sessions.length,
      active: sessions.filter((session) => ACTIVE_STATES.has(session.state)).length,
      recent: sessions.slice(0, RECENT_SESSIONS).map((session) => ({
        session_id: session.session_id,
        title: session.title,
        state: session.state,
        updated_at: session.updated_at,
      })),
    };
  };
}

const page = <A>(items: ReadonlyArray<A>, offset: number, size: number) => {
  const shown = items.slice(offset, offset + size);
  return {
    total: items.length,
    next_offset: offset + shown.length < items.length ? offset + shown.length : null,
    items: shown,
  };
};

/** The branch part of a remote ref such as origin/feature. */
const remoteBranchName = (ref: VcsRef) =>
  ref.remoteName !== undefined && ref.name.startsWith(`${ref.remoteName}/`)
    ? ref.name.slice(ref.remoteName.length + 1)
    : null;

function presentBranches(input: {
  readonly local: ReadonlyArray<VcsRef>;
  readonly remote: ReadonlyArray<VcsRef>;
  readonly current: string | null;
  readonly projectCheckout: string;
  readonly identityRemote: string | undefined;
  readonly query: string | undefined;
  readonly offset: number;
  readonly limit: number;
  readonly truncated: boolean;
}): Branches {
  const query = input.query?.trim().toLowerCase() ?? "";
  const matches = (ref: VcsRef) => ref.name.toLowerCase().includes(query);
  const onRemotes = new Map<string, Array<string>>();
  for (const ref of input.remote) {
    const branch = remoteBranchName(ref);
    if (branch !== null) onRemotes.set(branch, [...(onRemotes.get(branch) ?? []), ref.name]);
  }
  const localNames = new Set(input.local.map((ref) => ref.name));
  const remoteDefault = input.remote.find((ref) => ref.isDefault);
  const remotes = new Set(input.remote.flatMap((ref) => ref.remoteName ?? []));
  if (input.identityRemote !== undefined) remotes.add(input.identityRemote);
  return {
    current: input.current,
    default:
      input.local.find((ref) => ref.isDefault)?.name ??
      (remoteDefault === undefined ? null : remoteBranchName(remoteDefault)),
    remotes: [...remotes].toSorted(),
    local: page(
      input.local.filter(matches).map((ref) => ({
        name: ref.name,
        current: ref.current,
        default: ref.isDefault,
        checked_out_at: ref.worktreePath,
        remote_branches: onRemotes.get(ref.name) ?? [],
        // Git checks a branch out in one worktree at a time; the project
        // checkout's own branch needs no switch.
        session_checkouts:
          ref.worktreePath === null || trimPath(ref.worktreePath) === input.projectCheckout
            ? ["local" as const]
            : ["existing_worktree" as const],
      })),
      input.offset,
      input.limit,
    ),
    remote: page(
      input.remote.filter(matches).map((ref) => {
        const branch = remoteBranchName(ref);
        return {
          name: ref.name,
          remote: ref.remoteName ?? null,
          default: ref.isDefault,
          local_branch: branch !== null && localNames.has(branch),
        };
      }),
      input.offset,
      input.limit,
    ),
    ...(input.truncated ? { truncated: true as const } : {}),
  };
}

const scanRefs = Effect.fn("scanRefs")(function* (
  reads: VcsReads,
  cwd: string,
  refKind: "local" | "remote",
) {
  const refs: Array<VcsRef> = [];
  let cursor = 0;
  let last: VcsListRefsResult | undefined;
  for (let pageIndex = 0; pageIndex < MAX_REF_PAGES; pageIndex++) {
    last = yield* reads.listRefs({
      cwd,
      refKind,
      limit: REF_PAGE_SIZE,
      ...(cursor === 0 ? {} : { cursor }),
      // Re-read the server's ref snapshot once; later pages share it.
      ...(refKind === "local" && cursor === 0 ? { refresh: true } : {}),
      ...(refKind === "remote" ? { includeMatchingRemoteRefs: true } : {}),
    });
    refs.push(...last.refs);
    if (last.nextCursor === null) break;
    cursor = last.nextCursor;
  }
  return {
    isRepo: last!.isRepo,
    hasPrimaryRemote: last!.hasPrimaryRemote,
    refs,
    truncated: last!.nextCursor !== null,
  };
});

interface Request {
  readonly sections: ReadonlySet<Section>;
  readonly query: string | undefined;
  readonly offset: number;
  readonly branchLimit: number;
  readonly worktreeLimit: number;
}

/** The instance's Git sections, read over one socket. */
const readGit = Effect.fn("readGit")(function* (reads: VcsReads, entry: Entry, request: Request) {
  const { project } = entry;
  const wants = (section: Section) => request.sections.has(section);
  const absent = (section: Section) => (wants(section) ? null : undefined);
  const local = yield* scanRefs(reads, project.workspaceRoot, "local");
  if (!local.isRepo) {
    return {
      isRepo: false,
      hasRemote: undefined,
      checkout: absent("checkout"),
      branches: absent("branches"),
      worktrees: absent("worktrees"),
      errors: [],
    };
  }
  const [status, remote] = yield* Effect.all(
    [
      wants("checkout") || wants("worktrees")
        ? Effect.result(reads.status(project.workspaceRoot))
        : Effect.succeed(undefined),
      wants("branches")
        ? scanRefs(reads, project.workspaceRoot, "remote")
        : Effect.succeed(undefined),
    ],
    { concurrency: 2 },
  );
  const errors: Array<string> = [];
  if (status !== undefined && Result.isFailure(status)) errors.push(status.failure.message);
  const projectStatus = status !== undefined && Result.isSuccess(status) ? status.success : null;

  const checkedOut = local.refs.filter((ref) => ref.worktreePath !== null);
  const projectRef = checkedOut.find((ref) => ref.current);
  const projectCheckout = trimPath(projectRef?.worktreePath ?? project.workspaceRoot);
  const current = projectStatus?.local.refName ?? projectRef?.name ?? null;

  const branches = wants("branches")
    ? presentBranches({
        local: local.refs,
        remote: remote?.refs ?? [],
        current,
        projectCheckout,
        identityRemote: project.repositoryIdentity?.locator.remoteName,
        query: request.query,
        offset: request.offset,
        limit: request.branchLimit,
        truncated: local.truncated || remote?.truncated === true,
      })
    : undefined;

  let worktrees: Worktrees | undefined;
  if (wants("worktrees")) {
    const others = checkedOut.filter((ref) => trimPath(ref.worktreePath!) !== projectCheckout);
    const sessionsAt = sessionsByCheckout(entry.environment.id, entry.shell, [
      projectCheckout,
      ...others.map((ref) => ref.worktreePath!),
    ]);
    const candidates = others
      .map((ref, order) => ({ ref, order, sessions: sessionsAt(ref.worktreePath!) }))
      .toSorted(
        (left, right) => right.sessions.active - left.sessions.active || left.order - right.order,
      );
    const shown = candidates.slice(0, Math.max(0, request.worktreeLimit - 1));
    const statuses = yield* Effect.forEach(
      shown,
      ({ ref }) => Effect.result(reads.status(ref.worktreePath!)),
      { concurrency: STATUS_CONCURRENCY },
    );
    worktrees = {
      total: others.length + 1,
      more: others.length - shown.length,
      items: [
        {
          path: projectCheckout,
          branch: current,
          project_checkout: true,
          status: projectStatus === null ? null : presentStatus(projectStatus),
          sessions: sessionsAt(projectCheckout),
        },
        ...shown.map(({ ref, sessions }, index) => {
          const result = statuses[index]!;
          return {
            path: ref.worktreePath!,
            branch: ref.name,
            project_checkout: false,
            status: Result.isSuccess(result) ? presentStatus(result.success) : null,
            ...(Result.isFailure(result) ? { status_error: result.failure.message } : {}),
            sessions,
          };
        }),
      ],
      ...(local.truncated ? { truncated: true as const } : {}),
    };
  }

  return {
    isRepo: true,
    hasRemote: remote === undefined ? undefined : local.hasPrimaryRemote || remote.refs.length > 0,
    checkout:
      wants("checkout") && projectStatus !== null
        ? presentStatus(projectStatus)
        : absent("checkout"),
    branches,
    worktrees,
    errors,
  };
});

const inspectInstance = Effect.fn("inspectInstance")(function* (
  entry: Entry,
  config: Result.Result<ServerConfig, BridgeError> | undefined,
  request: Request,
  selected: boolean,
) {
  const { environment, project } = entry;
  const errors: Array<string> = [];
  const wants = (section: Section) => request.sections.has(section);
  // MCP structured content is JSON, so an unrequested section is omitted, never undefined.
  const section = <K extends Section, A>(key: K, value: A | null | undefined) =>
    wants(key) ? ({ [key]: value ?? null } as { readonly [P in K]: A | null }) : {};
  let settings: Settings | null = null;
  if (config !== undefined && Result.isSuccess(config)) {
    settings = presentSettings(config.success, project);
  } else if (config !== undefined) {
    errors.push(`Settings unavailable: ${config.failure.message}`);
  }
  const git =
    wants("checkout") || wants("branches") || wants("worktrees")
      ? yield* Effect.result(environment.readVcs((reads) => readGit(reads, entry, request)))
      : undefined;
  const read = git !== undefined && Result.isSuccess(git) ? git.success : undefined;
  if (git !== undefined && Result.isFailure(git)) errors.push(git.failure.message);
  if (read !== undefined) errors.push(...read.errors);
  return {
    server_id: environment.id,
    server_name: environment.name,
    project_id: project.id,
    name: project.title,
    path: project.workspaceRoot,
    selected,
    repository: presentRepository(project, read),
    ...section("settings", settings),
    ...section("checkout", read?.checkout),
    ...section("branches", read?.branches),
    ...section("worktrees", read?.worktrees),
    ...(errors.length > 0 ? { errors } : {}),
  } satisfies Instance;
});

export const inspectProject = Effect.fn("inspectProject")(function* (
  environments: typeof Environments.Service,
  input: Input,
): Effect.fn.Return<typeof Success.Type, BridgeError> {
  const selectors = [input.project_id, input.repository, input.name].filter(
    (value) => value != null,
  );
  if (selectors.length !== 1) {
    return yield* new BridgeError({
      message: "Pass exactly one of project_id (with server_id), repository, or name.",
    });
  }
  if (input.project_id != null && input.server_id == null) {
    return yield* new BridgeError({ message: "project_id requires its server_id." });
  }
  if (input.include_related != null && input.project_id == null) {
    return yield* new BridgeError({ message: "include_related applies only to project_id." });
  }
  const matchedBy: typeof Success.Type.matched_by =
    input.project_id != null ? "project_id" : input.repository != null ? "repository" : "name";
  const home = input.server_id == null ? undefined : yield* environments.get(input.server_id);
  const searchAll =
    home === undefined || (input.project_id != null && input.include_related !== false);
  const targets = searchAll ? yield* environments.enabled : [home];
  const shells = yield* Effect.forEach(
    targets,
    (environment) =>
      Effect.result(environment.shell).pipe(Effect.map((shell) => ({ environment, shell }))),
    { concurrency: "unbounded" },
  );
  const servers = shells.map(({ environment, shell }) => ({
    server_id: environment.id,
    name: environment.name,
    ...(Result.isFailure(shell) ? { error: shell.failure.message } : {}),
  }));
  const entries = shells.flatMap(({ environment, shell }) =>
    Result.isSuccess(shell)
      ? shell.success.projects.map((project) => ({ environment, shell: shell.success, project }))
      : [],
  );

  const selection = selectInstances(entries, input);
  if (selection.status === "not_found") {
    const unreachable = servers.filter((server) => server.error !== undefined);
    return yield* new BridgeError({
      code: "project_not_found",
      message: `${selection.message}${unreachable.length > 0 ? ` Not searched: ${unreachable.map((server) => `${server.server_id} (${server.error})`).join("; ")}.` : ""} Call list_projects for registered projects.`,
    });
  }
  const ref = (entry: Entry) => ({
    server_id: entry.environment.id,
    project_id: entry.project.id,
    name: entry.project.title,
    path: entry.project.workspaceRoot,
  });
  if (selection.status === "ambiguous") {
    return {
      status: "ambiguous" as const,
      matched_by: matchedBy,
      key: null,
      servers,
      instances: [],
      more_instances: 0,
      candidates: selection.groups.map((group) => {
        const identity = group[0]!.project.repositoryIdentity;
        return {
          key: keyOf(group[0]!.project),
          name:
            (identity == null ? undefined : repositoryGroupingDisplayNameOf(identity)) ??
            group[0]!.project.title,
          instances: group.map(ref),
        };
      }),
    };
  }

  const order = new Map(targets.map((environment, index) => [environment.id, index]));
  const ordered = selection.entries.toSorted(
    (left, right) =>
      Number(right === selection.selected) - Number(left === selection.selected) ||
      order.get(left.environment.id)! - order.get(right.environment.id)! ||
      left.project.workspaceRoot.localeCompare(right.project.workspaceRoot),
  );
  const shown = ordered.slice(0, MAX_INSTANCES);
  const sections = new Set(input.sections ?? ALL_SECTIONS);
  const request: Request = {
    sections,
    query: input.branch_query ?? undefined,
    offset: input.branch_offset ?? 0,
    branchLimit: input.branch_limit ?? DEFAULT_BRANCH_LIMIT,
    worktreeLimit: input.worktree_limit ?? DEFAULT_WORKTREE_LIMIT,
  };
  const configs = new Map(
    sections.has("settings")
      ? yield* Effect.forEach(
          [...new Set(shown.map((entry) => entry.environment))],
          (environment) =>
            Effect.result(environment.serverConfig).pipe(
              Effect.map((config) => [environment.id, config] as const),
            ),
          { concurrency: "unbounded" },
        )
      : [],
  );
  const instances = yield* Effect.forEach(
    shown,
    (entry) =>
      inspectInstance(
        entry,
        configs.get(entry.environment.id),
        request,
        entry === selection.selected,
      ),
    { concurrency: "unbounded" },
  );
  return {
    status: "resolved" as const,
    matched_by: matchedBy,
    key: selection.key,
    servers,
    instances,
    more_instances: ordered.length - shown.length,
    candidates: [],
  };
});
