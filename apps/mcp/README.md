# T3 Code MCP bridge

A headless T3 Code client that lets an MCP client such as ChatGPT start coding
sessions, find earlier ones, follow their progress, and send them follow-ups
without a T3 Code window open. One bridge can control several T3 servers. Each
server keeps running the agents; the bridge only asks it to, the same way the
web and mobile apps do.

It exposes these tools:

- `list_projects`: projects on every enabled server, plus the agents and models
  each server offers, with each model's reasoning effort levels. An unreachable
  server is reported with an error, and the other servers still list. See
  [Reasoning effort](#reasoning-effort).
- `inspect_project`: one project's repository identity, settings, checkout,
  branches, and worktrees on every server where it is registered. See
  [Inspecting a project](#inspecting-a-project).
- `create_project`: registers a folder or clones a repository on a selected server,
  returning `server_id` and `project_id` ready for `create_session`. See
  [Creating projects](#creating-projects).
- `get_usage`: read-only historical token and API-equivalent cost analytics,
  with provider/model filters and daily or hourly breakdowns across servers.
  See [Usage analytics](#usage-analytics).
- `list_sessions`: existing sessions, most recently active first, including
  ones started in T3 Code. Filter by server, project, or words from the title.
  Archived sessions are not listed.
- `create_session`: starts a new thread in a project with a task, and
  optionally an agent, model, and reasoning effort. Spoken names such as
  "Claude" or "opus" match. Choose a checkout with the optional `checkout`
  object; see [Session checkouts](#session-checkouts).
- `send_session_message`: sends a message into an existing session, which
  keeps its thread, history, agent, and model. See
  [Follow-up messages](#follow-up-messages).
- `control_session`: stops running work, resumes a held queue, or drops queued
  messages, as T3 Code's UI does. See [Controlling work](#controlling-work).
- `get_session_status`: reports state, recent agent messages and tool
  activity, files changed, queued messages, and pending questions or approvals.
  Pass back the returned `cursor` to get only newer updates.
- `respond_to_session`: submits the user's answers to a pending question, or
  their explicit decision on a pending approval. See
  [Questions and approvals](#questions-and-approvals).

## Inspecting a project

`list_projects` is the short directory. `inspect_project` looks at one
project closely before `create_session` acts on it. Select it with exactly
one of:

```json
{"server_id":"home","project_id":"project-id"}
{"repository":"github.com/owner/repo"}
{"name":"repo"}
```

The same repository can be registered on several servers, under different
project ids and paths, on different branches. The tool groups those
instances by the repository identity each server derives from Git remotes,
the same key T3 Code's sidebar groups by. A fork counts as its own project,
separate from the upstream it tracks. Projects are never grouped by name,
and a project with no identified repository stands alone.

- `project_id` inspects that instance, marked `selected`, and every other
  instance of its repository. `include_related: false` keeps only the one.
- `repository` takes a remote or web URL, a key such as
  `github.com/owner/repo`, or `owner/repo`. It matches the project's own
  repository first, then a fork's upstream.
- `name` matches a project title or repository name, whole and ignoring
  case. `server_id` limits `repository` and `name` to one server.

When a name or repository fits more than one project, `status` is
`ambiguous`. Nothing is inspected, and `candidates` lists each project with
all of its instances. Ask which one the user means, then call again with its
`project_id`. Each instance keeps its own `server_id`, `project_id`, and
`path`. Pass that instance's ids to `create_session`.

Each instance reports:

- `repository`: `status` is `identified` (with the key, canonical key,
  provider, and identifying remote), `not_git`, `no_remote`, or
  `unidentified`. `unidentified` can mean the server is still resolving the
  identity; retry shortly. Credentials in remote URLs are removed.
- `settings`: default agent, model, and reasoning effort; permission mode;
  whether new sessions in T3 Code start in a worktree (`null` means the
  repository's `t3.json` decides, else local); worktree and auto-pull
  settings; script names; and which settings the project overrides.
- `checkout`: the project checkout's branch, uncommitted changes, open pull
  request, and upstream. `tracking` includes ahead/behind counts. `none` means
  no upstream. `unknown` means the server has not checked the remote recently.
- `branches`: the current and default branch, remote names, and local and
  remote branches. A local branch shows the worktree it is checked out in.
  `session_checkouts` names the `create_session` checkout modes that accept it
  as `branch`. Any branch can be a worktree's `base_branch`.
- `worktrees`: each checkout, starting with the project checkout, plus its
  status and the sessions using it (`active` counts sessions that are
  queued, starting, running, or waiting). Worktrees with a detached HEAD are
  not listed.

Results are bounded. `sections` selects which details to read, and
`["settings"]` reads no Git state at all. `branch_query`, `branch_limit`
(default 10), and `branch_offset` filter and page both branch lists; pass a
list's `next_offset` back as `branch_offset`. `worktree_limit` (default 10)
caps worktrees. At most 20 instances are inspected; `more_instances` counts
the rest. Repositories with over 2,000 local or remote branches report
`truncated`; narrow those with `branch_query`.

The tool only reads. It does not fetch, pull, switch branches, or read file
contents. Remote state, such as ahead/behind counts and remote branches,
reflects each server's last fetch. A server that cannot be reached is
reported in `servers` while the others are inspected.

## Creating projects

Call `list_projects` to discover servers, then `create_project` with the chosen
`server_id` and one of these `source` objects:

```json
{"type":"local","path":"~/projects/my-app"}
{"type":"url","remote_url":"https://github.com/owner/repo.git","destination_path":"~/projects/repo"}
{"type":"github","repository":"owner/repo","destination_path":"~/projects/repo","protocol":"https"}
```

Local folders are created if missing and need not be Git repositories. Clone
URLs also accept SSH, local Git paths, and GitHub `owner/repo` shorthand.
Provider sources are `github`, `gitlab`, `forgejo` (including Gitea), `bitbucket`,
and `azure-devops`; repository lookup uses the selected server's provider
configuration and credentials. Identifiers follow the provider's normal format
(`owner/repo`, GitLab `group/project`, Bitbucket `workspace/repository`, or Azure
DevOps `project/repository`). Azure DevOps uses the organization configured
on the server. Use the `url` source for a clone URL.
Optional `protocol` accepts `https`, `ssh`, or `auto` (SSH). Omit it for the UI's
default: HTTPS for GitHub/Forgejo and SSH for the other providers.

Paths refer to the selected server. Use absolute or `~/` paths; explicit
relative paths require an active project and are rejected by this tool.
`destination_path` is the complete checkout folder, not its parent, and must
be missing or empty. The server rejects duplicate active project paths and
reports filesystem, repository lookup, authentication, and clone errors.

Success returns `server_id`, `project_id`, `name`, and the normalized `path`.
Pass those IDs directly to `create_session`. Repository creation waits up to
ten minutes for clone completion. A failure's `code` and `state` say what
exists on the server:

- `project_not_created` with `state: not_created`: the server refused before
  registering anything, such as a path another project holds or an unusable
  folder or repository. The message names the reason; fix the input and retry.
- `clone_failed` or `clone_unconfirmed` with `state: registered`: the project
  exists, but its clone failed, was cancelled, or stopped reporting and may
  still be running. Retry the clone in T3 Code, or delete the project there
  before reusing the path.
- `project_unconfirmed` with `state: unknown`: the request timed out or the
  connection dropped. Call `list_projects` before retrying.

## Session checkouts

Omit `checkout` (or pass `null`) to keep the existing behavior: run in the
project's current checkout without switching branches, even if project settings
prefer new worktrees. Paths and Git operations belong to the selected server.

`create_session` accepts these checkout choices:

```json
{"mode":"local"}
{"mode":"local","branch":"feature/existing"}
{"mode":"local","branch":"feature/new","create_branch":true}
{"mode":"worktree","base_branch":"main"}
{"mode":"worktree","base_branch":"main","branch":"feature/new","start_from_origin":true}
{"mode":"existing_worktree","branch":"feature/already-checked-out"}
```

`local` optionally switches to an existing ref, or creates and switches to a new
branch from the current HEAD when `create_branch` is true. Creating requires
`branch`. Switching changes the checkout used by every session sharing it;
T3's existing Git validation and conflict errors apply. Remote refs use T3's
normal local tracking-branch behavior. A successful branch change remains if
starting the agent subsequently fails.

`worktree` requires `base_branch`. Omit `branch` to let T3 name the branch, as it
does for new worktrees in the UI. T3 allocates the directory, creates the
branch/worktree, applies the project's submodule configuration, and runs its
configured worktree setup actions. `start_from_origin` defaults to false; when
true, T3 fetches origin and uses its version of the base branch when available,
falling back to the local branch. Existing branch names, invalid refs, checkout
conflicts, and setup failures fail the session's first turn; the error names the
cause, and the session stays in T3 Code, where its preparation can be retried.

`existing_worktree` reuses the given local branch's checkout, discovered from
T3's project ref list; it fails if no such checkout exists. Selecting the main
checkout normalizes to local execution. This does not create a worktree or run
setup actions.

Creation returns `branch` and `worktree_path` as well as the session IDs.
Worktree setup can take minutes; the bridge waits up to ten minutes. A timeout
or lost connection may leave setup running. Check `list_sessions` before
retrying, then monitor `get_session_status` for completion or failure.

## Reasoning effort

`list_projects` reports every model's reasoning effort with the model, under
its agent:

```json
{
  "model": "gpt-6-astra",
  "name": "GPT-6 Astra",
  "reasoning_effort_support": "configurable",
  "reasoning_efforts": [
    { "value": "low", "name": "Low" },
    { "value": "medium", "name": "Medium" },
    { "value": "high", "name": "High" },
    { "value": "xhigh", "name": "Extra High" }
  ],
  "default_reasoning_effort": "medium"
}
```

The levels are the ones the server reports for that model, as in T3 Code's
reasoning picker. `not_configurable` means the model has no effort setting, as
with Antigravity. `unknown` means the server sent no option metadata for the
model. Claude's `ultrathink` is not listed because T3 Code applies it by
writing it into the prompt; write it in the task instead.

Pass a `value` as `create_session`'s `reasoning_effort`, with that model and its
`agent`. Spoken forms of a listed level ("Extra High", "x-high")
also match. Levels the model does not list, and any level for a
`not_configurable` or `unknown` model, are rejected before a session starts.
Omitting `reasoning_effort` keeps the project's default, or the model's.

`create_session`, `list_sessions`, and `get_session_status` report the
session's `reasoning_effort`, or `null` when it uses the model's default. It
follows changes made later in T3 Code.

## Questions and approvals

When `get_session_status` reports `waiting`, inspect `waiting_for`. Pending
requests are returned even when the status cursor filters out older updates.
Present the actual question or complete approval request to the user and obtain
their response before submitting it with `respond_to_session`. Never infer
approval from a task instruction or automatically choose a question's suggested
answer. Pass exactly one of `answers` (for a question) or `decision` (for an
approval); a response of the wrong kind for the request is rejected.

Each entry in `waiting_for.questions` includes `request_id`, `question_id`,
`header`, the question text, `multi_select`, `allow_custom_answer`, and `choices`
with labels, descriptions, and exact values. The existing `options` label list
remains available. A request can contain several questions; submit all of its
answers together, keyed by `question_id`, with no extra IDs:

```json
{
  "server_id": "home",
  "session_id": "session-id",
  "request_id": "question-request-id",
  "answers": {
    "target": "choice-value",
    "features": ["value-a", "value-b"],
    "notes": "The user's exact text"
  }
}
```

Use strings for single selections or supported free text, and arrays of exact
choice values for multiple selections. Preserve IDs, values, and the user's
text, including whitespace. Unsupported custom answers, invalid selections,
missing/extra question IDs, and stale requests fail without dispatching a
response. Both native provider questions and T3's async message-mode questions
are answered through T3's runtime request response, as in the UI.

Each entry in `waiting_for.approvals` includes `request_id`, kind, the complete
available detail, optional application name, and provider-supplied options with
warnings. Explain these to the user, explicitly ask whether they approve or deny,
then call `respond_to_session` with the IDs and their `decision`:

```json
{
  "server_id": "home",
  "session_id": "session-id",
  "request_id": "approval-request-id",
  "decision": "decline"
}
```

`accept` approves once, `decline` denies, and `cancel` cancels the request.
`acceptForSession` and `acceptAlways` broaden permission and require the user's
explicit agreement to that scope. If the request supplies options, only those
decisions are accepted. Older requests without options use T3's defaults:
`accept`, `decline`, `cancel`, and `acceptForSession`; `acceptAlways` must be
explicitly offered. Provider-specific meanings and safeguards remain with T3's
existing approval adapters and authorization.

`respond_to_session` returns `accepted:true` and a status `cursor`. This means T3
accepted the response command, not that the provider has finished resolving it.
Pass the cursor to `get_session_status` and keep monitoring: provider failures,
including a request becoming stale between inspection and submission, appear
through the normal activity stream. Other pending requests can keep the session
waiting. After a failure, inspect current status before retrying.

## Running

```sh
node apps/mcp/src/bin.ts --data-dir /data --host 0.0.0.0 --admin-host 0.0.0.0
```

| Flag           | Environment         | Default       | Purpose                           |
| -------------- | ------------------- | ------------- | --------------------------------- |
| `--data-dir`   | `T3_MCP_DATA_DIR`   | `t3-mcp-data` | Paired servers and the MCP secret |
| `--host`       | `T3_MCP_HOST`       | `127.0.0.1`   | Interface for the MCP endpoint    |
| `--port`       | `T3_MCP_PORT`       | `8787`        | Port for the MCP endpoint         |
| `--admin-host` | `T3_MCP_ADMIN_HOST` | `127.0.0.1`   | Interface for the admin page      |
| `--admin-port` | `T3_MCP_ADMIN_PORT` | `8788`        | Port for the admin page           |

The bridge keeps its state in `<data-dir>/state.json`, readable only by its
owner. It holds a bearer token for every paired server, so back it up like a
secret. The first start generates the MCP secret.

`vp pack` in this directory bundles the bridge into one file, `dist/bin.mjs`,
which needs only Node. `scripts/self-hosted/mcp.Dockerfile` wraps it in an image
that keeps state in `/data` and listens on all interfaces.

The two listeners have different audiences:

- The MCP port is the one to publish, for example through a Cloudflare tunnel.
  Only `/mcp/<secret>` answers there. ChatGPT connectors cannot send custom
  headers, so the secret in the path is the bridge's credential.
- The admin port must stay private: it shows the MCP URL and can pair servers.
  Reach it over your tailnet or `kubectl port-forward`. It refuses form posts
  from other sites.

## Admin page

Open the admin port in a browser.

- **MCP endpoint** shows the URL to give ChatGPT once you enter the public URL
  the bridge is reached at. In ChatGPT, add a custom connector (developer mode)
  with that URL and no authentication. **Rotate secret** issues a new URL and
  stops the old one immediately.
- **T3 servers** lists every paired server with its status and token expiry.
  Edit a server's id or name, disable it to hide it from the tools without
  forgetting its token, re-pair it, or remove it. Changes apply to the next
  tool call, without a restart. The id is the `server_id` a chat uses, so
  renaming breaks the session ids it already holds.
- **Pair a server** takes a pairing link. Create one in T3 Code under Settings →
  Connections on that server. The bridge asks only for the permissions its
  tools use: view environment and operate tasks, view diagnostics and usage
  (`get_usage`), and change source control (cloning in `create_project` and
  branch checkouts). It never asks for terminals, files, settings, or access
  control. A link that leaves one of these out still pairs, but the tools that
  need it fail and the server's status says which permissions are missing. The
  server lists the bridge as "T3 MCP bridge" under its Connections, where you
  can revoke it.

Tokens from pairing last 30 days. The admin page shows how long each has left,
and `list_projects` warns during the last week so the chat can remind you.
Re-pair with a new link from the same server to refresh one, or to grant
permissions a token lacks. Tokens paired before usage and source control had
their own permissions lack them until re-paired.

The bridge needs T3 Code with Orchestrator V2 on each server. A server running
an older version shows "Automatically disabled because the server is too old"
with its version. Its projects and sessions are hidden from the tools, and calls
that name it fail with that reason. Update T3 Code on that server, and the
bridge uses it again on the next call; there is nothing to re-enable.

## Behavior to know

- A session uses the project's default agent, model, reasoning effort, and
  permission mode, as a new thread in the UI would. With full access, the agent can do anything the
  server's account can.
- Sessions start in the project's checkout by default; `checkout` selects a
  branch or worktree explicitly.
- When the agent asks for approval or input, the state is `waiting`. Obtain the
  user's response and submit it with `respond_to_session` or in T3 Code.
- The bridge logs every session it creates, with its server, project, agent,
  model, and reasoning effort, and every message it sends, without the text.

## Follow-up messages

`send_session_message` takes `server_id`, `session_id`, `message`, and an
optional `mode`:

- `steer`: redirect the active turn, like T3 Code's **Send now**. During active
  work, `delivery` is `steered`. Depending on the provider, the turn takes the
  message in place or is interrupted and restarted with it. T3 rejects steering
  while the turn is still starting or when the provider cannot steer.
- `queue`: run the message as the next turn once the active one ends, like T3
  Code's **Queue**. `delivery: queued` means T3 holds it; it never enters the
  current turn. While waiting for approval or input, it waits for that turn to
  end.
- Omit `mode` (or pass `null`) for T3 Code's default send: steer the active turn
  when the provider can (`delivery: during_turn`), and queue it otherwise
  (`delivery: queued`). Like explicit steering, this refuses messages while
  waiting for approval or input.

Both explicit modes and the default return `delivery: new_turn` when the
session is idle, completed, interrupted, or failed. They continue the same
session with its agent and model.

The result includes `message_id` and `cursor`. Pass the cursor to
`get_session_status` to see what happens after the send. Its `queued_messages`
field lists every message on the session still waiting for its turn, whether
queued through the bridge or in T3 Code. Each has `state` `waiting`, to run
after the active turn, or `held` after a stop, until `control_session`
resumes the queue; `control_session` reports the queue the same way. Queued
messages wait on the T3
server, so they survive a bridge restart. Drop them with `control_session`, or
edit or remove them in T3 Code. Once a queued message starts, it leaves the list and appears in the session history. An
archived or deleted session is reported as not found.

## Controlling work

`control_session` takes `server_id`, `session_id`, and an `action`. Each result
reports `result`, `dropped_message_ids`, the observed `state`, the updated
`queued_messages` (each `waiting` to run after the active turn, or `held`), and
a status `cursor`.

- `stop` is T3 Code's Stop. It requests provider interruption, including while
  the session is starting or the agent is waiting for approval or input. As in
  the UI, queued messages are held instead of starting next. The session and
  history remain available; send another message to continue. Providers use
  their existing cancellation behavior for tools and subprocesses; some close
  the provider runtime and reopen it on the next message. `stop_requested`
  confirms command acceptance, and `state` may still be active; use
  `get_session_status` to confirm settlement or see provider errors.
  `already_inactive` means no running work remained when checked. Work that is
  not a run T3 can stop, such as a subagent's own session, returns
  `BridgeError` with `code: interrupt_not_applicable`.
- `resume_queue` releases held messages, as the UI's resume does, so they run
  in order (`queue_resumed`). With nothing held it sends nothing and returns
  `nothing_held`.
- `drop_queued` deletes queued messages: all of them, or only those in
  `message_ids`. Every listed ID must be in `queued_messages`; an unknown ID,
  or one that already started or was dropped, fails the call with
  `code: not_queued` and nothing is dropped. If a message starts while the
  bridge is dropping several, the error names the ones already dropped. Only
  drop messages at the user's request.

Steering over a pending question or approval returns
`code: message_not_applicable` and `state: waiting`.

## Usage analytics

`get_usage` reads the same provider history and prices as **Usage** in T3 Code.
It includes work outside T3. Omit `server_id` to merge all enabled paired
servers, or pass an id from `list_projects` to select one. Shared history
(including the same Cursor account on multiple machines) counts once, using
T3's existing source ownership rules. Errors from individual servers appear
in `servers`; other servers still contribute.

Pass explicit `since_day`, `until_day` and `time_zone`. Daily dates are inclusive
calendar dates in that IANA timezone, regardless of the server's timezone.
For today, pass the same date twice. For this week, pass your intended week's
first date through today. For the last 30 calendar days, start 29 days before
today. This example reports September 2026 usage by provider and model:

```json
{
  "since_day": "2026-09-01",
  "until_day": "2026-09-30",
  "time_zone": "America/Chicago",
  "group_by": ["provider", "model"]
}
```

`providers` filters exact provider kinds: `codex`, `claude`, `grok`, `cursor`,
`opencode`, or `antigravity`. `models` filters exact, case-sensitive model IDs
from the returned groups. Provider means the agent runtime, not a configured
agent/account ID or the company serving the model. Project, thread, individual
agent, and account attribution are not available in the canonical usage data.

Omit `group_by` for totals only, or combine `provider`, `model`, and one of
`day` or `hour`. Use `["day"]` for a trend or `["day", "provider"]` to compare
providers over time. Only periods with observed records have groups. Daily
queries accept up to 3660 calendar days; older history is available only while
its underlying records remain available on the server.

Hourly queries require `resolution: "hour"`, `since_time` and `until_time` as
ISO 8601 instants with `Z` or an explicit offset, spanning at most 24 hours.
The first instant is inclusive and the last is exclusive. The dates must match
these instants in `time_zone`. Buckets are fixed 60-minute periods anchored at
`since_time`, with a potentially shorter last period. Their `hour` labels are
UTC instants, so repeated local hours during daylight-saving transitions stay
distinct. For example, a rolling 24-hour breakdown:

```json
{
  "since_day": "2026-09-28",
  "until_day": "2026-09-29",
  "time_zone": "America/Chicago",
  "resolution": "hour",
  "since_time": "2026-09-28T12:00:00-05:00",
  "until_time": "2026-09-29T12:00:00-05:00",
  "group_by": ["hour", "provider"]
}
```

`totals` always covers the entire filtered window. `groups` returns up to
`limit` entries (default 50, maximum 100), in stable dimension order. Pass
`next_offset` as `offset` with the same query to get the next page. Each call
reads current history; pages are not a frozen snapshot.

Token and cost fields in `totals` and each group's `metrics` mean:

| Field                 | Meaning                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uncachedInputTokens` | Input processed without reading or creating a cache.                                                                                                     |
| `cachedInputTokens`   | Cache-read input.                                                                                                                                        |
| `cacheCreationTokens` | Cache-write input, disjoint from the other input counts.                                                                                                 |
| `outputTokens`        | Output including reasoning.                                                                                                                              |
| `reasoningTokens`     | Reported reasoning, already included in output; never add it again.                                                                                      |
| `totalTokens`         | All three input counts plus output.                                                                                                                      |
| `costUsd`             | API-equivalent USD, not subscription spending. Server custom prices override automatic pricing; otherwise provider-reported cost or LiteLLM rates apply. |
| `cacheSavingsUsd`     | Cache-read savings compared with full input rates, where rates are available.                                                                            |
| `records`             | Canonical deduplicated usage records; not necessarily turns or messages.                                                                                 |
| `unpricedRecords`     | Records counted in tokens but excluded from cost because rates are unknown. Zero cost can mean unknown.                                                  |
| `sessions`            | Distinct contributing native sessions per source. `null` for model filters or model/time groups, where distinct counts cannot be recovered from buckets. |

A zero token field does not establish whether a provider reported it. Missing
or unrecognized usage is not estimated from conversation text. Inspect each
server's `sources`, `pricing`, `error`, and `contract_version`, plus
`contract_mismatches`, to assess coverage. Sources report missing/partial/failed
reads, scanned and skipped files, and explanatory messages. `malformedRecords`
is currently not a comprehensive count of missing usage. Incompatible server
contracts are excluded; `duplicate_sources` identifies overlap removed from
the merge, and `contributing_servers` identifies servers that supplied records.

The tool does not run agents, change settings, enable provider access, or
explicitly refresh model rates. Normal usage reads may warm the server's
existing scan and pricing caches.
