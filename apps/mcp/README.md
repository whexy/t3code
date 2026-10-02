# T3 Code MCP bridge

A headless T3 Code client that lets an MCP client such as ChatGPT start coding
sessions, find earlier ones, follow their progress, and send them follow-ups
without a T3 Code window open. One bridge can control several T3 servers. Each
server keeps running the agents; the bridge only asks it to, the same way the
web and mobile apps do.

It exposes these tools:

- `list_projects`: projects on every enabled server, plus the agents and models
  each server offers. An unreachable server is reported with an error, and the
  other servers still list.
- `get_model_capabilities`: the reasoning effort levels one model accepts, for
  `create_session`'s `reasoning_effort`. See [Reasoning effort](#reasoning-effort).
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
- `interrupt_session`: requests Stop for running work while preserving the
  session and history. See [Stopping work](#stopping-work).
- `get_session_status`: reports state, recent agent messages and tool
  activity, and files changed. Pass back the returned `cursor` to get only
  newer updates.

- `answer_session_question`: submits the user's answers to a pending question
  request, including choice values, multiple selections, and supported free text.
- `respond_to_session_approval`: submits the user's explicit approval decision
  through T3's existing permission flow.

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
ten minutes for clone completion. A failed, cancelled, disconnected, or
timed-out clone may leave a registered project (and a timed-out clone can
continue running). Inspect it in T3 Code to retry or remove it before making
another creation request. `list_projects` finds any registered project.

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
{"mode":"worktree","base_branch":"main","branch":"feature/new","start_from_origin":true,"run_setup_script":true}
{"mode":"existing_worktree","branch":"feature/already-checked-out"}
```

`local` optionally switches to an existing ref, or creates and switches to a new
branch from the current HEAD when `create_branch` is true. Creating requires
`branch`. Switching changes the checkout used by every session sharing it;
T3's existing Git validation and conflict errors apply. Remote refs use T3's
normal local tracking-branch behavior. A successful branch change remains if
starting the agent subsequently fails.

`worktree` requires `base_branch`. Omit `branch` for T3's temporary branch naming.
T3 allocates the directory, creates the branch/worktree, applies the project's
submodule configuration, and runs its configured worktree setup actions by
default. `run_setup_script:false` skips those actions. `start_from_origin` defaults
to false; when true, T3 fetches origin and uses its version of the base branch
when available, falling back to the local branch. Existing branch names, invalid
refs, checkout conflicts, and setup failures are handled by the server's normal
bootstrap flow. Servers without the required-worktree capability are rejected
so they cannot silently run in the project checkout.

`existing_worktree` reuses the given local branch's checkout, discovered from
T3's project ref list; it fails if no such checkout exists. Selecting the main
checkout normalizes to local execution. This does not create a worktree or run
setup actions.

Creation returns `branch` and `worktree_path` as well as the session IDs.
Worktree setup can take minutes; the bridge waits up to ten minutes. A timeout
or lost connection may leave setup running. Check `list_sessions` before
retrying, then monitor `get_session_status` for completion or failure.

## Reasoning effort

`list_projects` names each server's models without their options. After
choosing one, call `get_model_capabilities` with `server_id`, `model`, and
optionally `agent`; they resolve the same names `create_session` accepts:

```json
{
  "server_id": "mudd",
  "agent": "codex",
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

Pass a `value` as `create_session`'s `reasoning_effort`, with the returned
`agent` and `model`. Spoken forms of a listed level ("Extra High", "x-high")
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
their response before submitting it. Never infer approval from a task instruction
or automatically choose a question's suggested answer.

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
use the existing `thread.user-input.respond` flow.

Each entry in `waiting_for.approvals` includes `request_id`, kind, the complete
available detail, optional application name, and provider-supplied options with
warnings. Explain these to the user, explicitly ask whether they approve or deny,
then call `respond_to_session_approval` with the IDs and their `decision`:

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

Both response tools return `accepted:true` and a status `cursor`. This means T3
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
  Connections on that server. The bridge gets permission only to read and run
  threads, with no terminal or access control. The server lists it as "T3 MCP
  bridge" under its Connections, where you can revoke it.

Tokens from pairing last 30 days. The admin page shows how long each has left,
and `list_projects` warns during the last week so the chat can remind you.
Re-pair with a new link from the same server to refresh one.

## Behavior to know

- A session uses the project's default agent, model, reasoning effort, and
  permission mode, as a new thread in the UI would. With full access, the agent can do anything the
  server's account can.
- Sessions start in the project's checkout by default; `checkout` selects a
  branch or worktree explicitly.
- When the agent asks for approval or input, the state is `waiting`. Obtain the
  user's response and submit it through the matching response tool or T3 Code.
- The bridge logs every session it creates, with its server, project, agent,
  model, and reasoning effort, and every message it sends, without the text.

## Follow-up messages

`send_session_message` takes `server_id`, `session_id`, `message`, and an
optional `mode`:

- `steer`: send immediately, like T3 Code's **Send now**. During active work,
  `delivery` is `steered`. The provider may incorporate the message, cancel and
  re-prompt, or handle it next; acceptance does not guarantee immediate uptake.
- `queue`: hold until the next completed tool call or the end of the turn,
  like T3 Code's **Queue**. This can deliver into the current turn before it
  ends. `delivery: queued` confirms the bridge is holding the message, not that
  the provider has received it. While waiting for approval or input, the queue
  holds until the user answers through the response tools or in T3 Code.
- Omit `mode` (or pass `null`) for the existing immediate-send behavior:
  `delivery: during_turn` while active. Like explicit steering, this refuses
  messages while waiting for approval or input.

Both explicit modes and the default return `delivery: new_turn` when the
session is idle, completed, interrupted, or failed and no queue is holding the
message. They continue the same session with its agent and model.

The result includes `message_id` and `cursor`. Pass the cursor to
`get_session_status` to see what happens after the send. Its `queued_messages`
field shows messages held by this bridge, dispatches in progress, and delivery
failures or cancellations. Delivered messages leave the queue and appear in
the session history. Queue entries are in memory and are lost on bridge restart;
a connection failure marks them failed rather than automatically replaying a
potentially accepted message. An archived or deleted session is reported as
not found.

## Stopping work

Call `interrupt_session` with `server_id` and `session_id` to use T3 Code's
Stop action. It cancels the bridge's held messages and requests provider
interruption, including when a running agent is waiting for approval or input.
The session and history remain available; send another message to resume.
Providers use their existing cancellation behavior for tools and subprocesses;
some close the provider runtime and reopen it on the next message.

`result: interrupt_requested` confirms command acceptance. `state` is the
observed state afterward and may still be active; use `get_session_status` to
confirm settlement or see provider errors. `already_inactive` means no running
work remained when checked, including completion races. `turn_changed` means
a different active turn was observed before dispatch and was left running.
`cancelled_message_ids` identifies messages removed from automatic delivery.
Concurrent activity after dispatch follows T3's session-level Stop semantics.

The composer's Stop action is unavailable during queued/starting work. The
bridge returns `BridgeError` with `code: interrupt_not_applicable` and the
observed `state`; retry once the provider is running. Steering over a pending
question or approval returns `code: message_not_applicable` and `state: waiting`.

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
