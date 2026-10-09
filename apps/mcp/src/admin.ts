import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { check, pair, type ServerHealth } from "./access.ts";
import {
  addServer,
  type BridgeState,
  Registry,
  removeServer,
  repairServer,
  setPublicUrl,
  updateServer,
} from "./registry.ts";

const DAY_MS = 86_400_000;
const EXPIRY_WARNING_DAYS = 7;

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

const mcpUrl = (state: BridgeState) => `${state.publicUrl ?? ""}/mcp/${state.secret}`;

function healthLabel(health: ServerHealth | undefined, nowMs: number) {
  switch (health?.status) {
    case "connected": {
      if (health.missing.length > 0) {
        return {
          text: "Connected without some permissions · re-pair",
          tone: "warn",
          detail: `missing ${health.missing.join(", ")}`,
        };
      }
      if (health.expiresAt === null) return { text: "Connected", tone: "ok" };
      const days = Math.floor((Date.parse(health.expiresAt) - nowMs) / DAY_MS);
      return {
        text: `Connected · token expires ${days < 1 ? "within a day" : `in ${days} days`}`,
        tone: days < EXPIRY_WARNING_DAYS ? "warn" : "ok",
      };
    }
    case "too_old":
      return {
        text: "Automatically disabled because the server is too old",
        tone: "warn",
        detail: `T3 Code ${health.serverVersion}`,
      };
    case "rejected":
      return { text: "Token rejected · re-pair", tone: "bad" };
    case "unreachable":
      return { text: "Unreachable", tone: "bad", detail: health.detail };
    default:
      return { text: "Unknown", tone: "bad" };
  }
}

const button = (
  action: string,
  label: string,
  fields: Record<string, string>,
  options: { readonly confirm?: string; readonly variant?: "danger" } = {},
) =>
  `<form method="post" action="${action}"${options.confirm ? ` onsubmit="return confirm('${escape(options.confirm)}')"` : ""}>${Object.entries(
    fields,
  )
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(value)}">`)
    .join(
      "",
    )}<button${options.variant ? ` class="${options.variant}"` : ""}>${label}</button></form>`;

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --surface: #fff; --text: #16181d; --muted: #667085; --line: #e2e5ea;
    --accent: #4f46e5; --accent-text: #fff; --field: #fff;
    --ok: #16803c; --warn: #b45309; --bad: #c2261f;
    --ok-bg: #e9f7ee; --warn-bg: #fdf3e1; --bad-bg: #fdecea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111318; --surface: #1a1d24; --text: #e8eaee; --muted: #98a0ae; --line: #2b2f38;
      --accent: #818cf8; --accent-text: #12141a; --field: #12141a;
      --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
      --ok-bg: #12261a; --warn-bg: #2a2110; --bad-bg: #2c1615;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 2.5rem 1rem 4rem; display: grid; gap: 2rem; }
  h1 { margin: 0; font-size: 1.35rem; letter-spacing: -.01em; }
  h2 { margin: 0 0 .6rem; font-size: .8rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  h2 .count { font-weight: 500; }
  p { margin: 0; }
  code { font: .9em ui-monospace, monospace; }
  header p { color: var(--muted); margin-top: .15rem; }

  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem; display: grid; gap: .9rem; }
  .card + .card { margin-top: .75rem; }
  .hint { color: var(--muted); font-size: .9em; }
  .divider { border: 0; border-top: 1px solid var(--line); margin: 0; }

  form { margin: 0; }
  form.stack { display: grid; gap: .6rem; }
  form.row { display: flex; gap: .6rem; align-items: flex-end; flex-wrap: wrap; }
  .fields { display: flex; gap: .6rem; flex-wrap: wrap; flex: 1 1 auto; }
  label { display: grid; gap: .25rem; font-size: .9em; font-weight: 500; flex: 1 1 12rem; }
  label.wide { flex-basis: 22rem; }
  input:not([type=hidden]) { font: inherit; font-weight: 400; color: var(--text); background: var(--field); border: 1px solid var(--line); border-radius: 6px; padding: .4rem .55rem; min-width: 0; width: 100%; }
  input[readonly] { font-family: ui-monospace, monospace; font-size: .9em; }
  input:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  button { font: inherit; font-weight: 500; color: var(--text); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: .4rem .8rem; cursor: pointer; white-space: nowrap; }
  button:hover { border-color: var(--muted); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  button.primary:hover { filter: brightness(1.08); }
  button.danger { color: var(--bad); }
  button.danger:hover { border-color: var(--bad); }

  .banner { padding: .6rem .9rem; border-radius: 8px; border: 1px solid; }
  .banner.ok { color: var(--ok); background: var(--ok-bg); border-color: currentColor; }
  .banner.bad { color: var(--bad); background: var(--bad-bg); border-color: currentColor; }
  .banner.warn { color: var(--warn); background: var(--warn-bg); border-color: currentColor; }

  .copy { display: flex; gap: .5rem; }
  .copy input { flex: 1; }

  .server { padding: 0; gap: 0; }
  .server.disabled .server-head, .server.disabled .server-url { opacity: .55; }
  .server-head { display: flex; align-items: center; gap: .75rem; padding: .9rem 1.1rem .2rem; }
  .server-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
  .server-title strong { font-size: 1rem; }
  .chip { font: .8rem ui-monospace, monospace; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 .35rem; }
  .server-url { padding: 0 1.1rem; color: var(--muted); font-size: .9em; word-break: break-all; }
  .status { display: flex; align-items: center; gap: .4rem; padding: .35rem 1.1rem .9rem; font-weight: 500; }
  .status::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: currentColor; flex: none; }
  .status.ok { color: var(--ok); } .status.warn { color: var(--warn); } .status.bad { color: var(--bad); }
  .status .detail { color: var(--muted); font-weight: 400; font-size: .9em; }
  .status .off { color: var(--muted); font-weight: 400; }

  details.manage { border-top: 1px solid var(--line); }
  details.manage > summary { cursor: pointer; padding: .55rem 1.1rem; color: var(--muted); font-weight: 500; list-style: none; user-select: none; }
  details.manage > summary::before { content: "▸"; display: inline-block; width: 1rem; transition: transform .1s; }
  details.manage[open] > summary::before { transform: rotate(90deg); }
  details.manage > summary:hover { color: var(--text); }
  .panel { display: grid; gap: 1rem; padding: .3rem 1.1rem 1.1rem; }
  .panel h3 { margin: 0 0 .4rem; font-size: .9rem; }
  .panel-foot { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }

  .empty { text-align: center; color: var(--muted); padding: 1.2rem; }
`;

function renderPage(input: {
  readonly state: BridgeState;
  readonly health: ReadonlyMap<string, ServerHealth>;
  readonly nowMs: number;
  readonly mcpListen: string;
  readonly notice: string | null;
  readonly error: string | null;
}) {
  const { state } = input;
  const cards = state.servers
    .map((server) => {
      const status = input.health.get(server.id);
      const health = healthLabel(status, input.nowMs);
      const id = escape(server.id);
      const disabled = !server.enabled || status?.status === "too_old";
      return `<article class="card server${disabled ? " disabled" : ""}">
  <div class="server-head">
    <div class="server-title"><strong>${escape(server.name)}</strong><span class="chip">${id}</span></div>
    ${button("/servers/toggle", server.enabled ? "Disable" : "Enable", { id: server.id })}
  </div>
  <div class="server-url">${escape(server.url)}</div>
  <div class="status ${health.tone}">${escape(health.text)}${"detail" in health ? ` <span class="detail">${escape(health.detail)}</span>` : ""}${server.enabled ? (status?.status === "too_old" ? ` <span class="off">· hidden from tools until it is updated</span>` : "") : ` <span class="off">· disabled, hidden from tools</span>`}</div>
  <details class="manage"><summary>Manage</summary>
    <div class="panel">
      <form method="post" action="/servers/update" class="stack">
        <input type="hidden" name="id" value="${id}">
        <div class="fields">
          <label>Name <input name="name" value="${escape(server.name)}" required></label>
          <label>Server id <input name="newId" value="${id}" required pattern="[a-z0-9][a-z0-9_-]*"></label>
        </div>
        <p class="hint">The id is the <code>server_id</code> chats use. Changing it breaks session ids a chat already holds for this server.</p>
        <div><button class="primary">Save</button></div>
      </form>
      <hr class="divider">
      <form method="post" action="/servers/repair" class="stack">
        <input type="hidden" name="id" value="${id}">
        <label>New pairing link <input name="link" required placeholder="https://…/pair#token=…"></label>
        <div><button>Re-pair</button></div>
      </form>
      <hr class="divider">
      <div class="panel-foot">
        <p class="hint">The bridge forgets this server's token.</p>
        ${button("/servers/remove", "Remove server", { id: server.id }, { confirm: `Remove ${server.id}? The bridge forgets its token.`, variant: "danger" })}
      </div>
    </div>
  </details>
</article>`;
    })
    .join("\n");

  const endpoint =
    state.publicUrl === null
      ? `<p class="banner warn">Set the public URL below to see the full MCP endpoint.</p>`
      : `<div class="copy"><input id="endpoint" readonly value="${escape(mcpUrl(state))}" aria-label="MCP endpoint"><button type="button" class="primary" onclick="navigator.clipboard.writeText(document.getElementById('endpoint').value).then(()=>{this.textContent='Copied';setTimeout(()=>{this.textContent='Copy'},1500)})">Copy</button></div>
  <p class="hint">In ChatGPT, add a custom connector (developer mode) with this URL and no authentication. The path secret is the credential.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>T3 Code MCP bridge</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
  <h1>T3 Code MCP bridge</h1>
  <p>Lets MCP clients start and follow coding sessions on your T3 servers.</p>
</header>
${input.notice ? `<p class="banner ok" role="status">${escape(input.notice)}</p>` : ""}
${input.error ? `<p class="banner bad" role="alert">${escape(input.error)}</p>` : ""}

<section>
  <h2>MCP endpoint</h2>
  <div class="card">
    ${endpoint}
    <hr class="divider">
    <form method="post" action="/settings" class="row">
      <label>Public URL <input name="publicUrl" type="url" value="${escape(state.publicUrl ?? "")}" placeholder="https://t3-mcp.example.com"></label>
      <button>Save</button>
    </form>
    <p class="hint">The MCP listener is <code>${escape(input.mcpListen)}</code>. Route only <code>/mcp/</code> on your public hostname to it.</p>
    <hr class="divider">
    <div class="panel-foot">
      <p class="hint">Issues a new endpoint URL. The current one stops working immediately.</p>
      ${button("/secret", "Rotate secret", {}, { confirm: "Rotate the secret? The current MCP URL stops working immediately.", variant: "danger" })}
    </div>
  </div>
</section>

<section>
  <h2>T3 servers <span class="count">· ${state.servers.length}</span></h2>
  ${state.servers.length === 0 ? `<div class="card empty">No servers yet. Pair one below.</div>` : cards}
</section>

<section>
  <h2>Pair a server</h2>
  <form method="post" action="/servers/pair" class="card">
    <div class="fields">
      <label class="wide">Pairing link <input name="link" required placeholder="https://…/pair#token=…"></label>
      <label>Server id (optional) <input name="id" pattern="[a-z0-9][a-z0-9_-]*" placeholder="from the server's name"></label>
    </div>
    <p class="hint">In T3 Code, open Settings → Connections on that server and create a pairing link. Links work once and expire after a few minutes. The bridge asks only to view and operate tasks, read usage, and change source control, and tokens last 30 days.</p>
    <div><button class="primary">Pair</button></div>
  </form>
</section>
</main>
</body>
</html>`;
}

const back = (message: { readonly notice: string } | { readonly error: string }) =>
  HttpServerResponse.redirect(`/?${new URLSearchParams(message)}`, { status: 303 });

/** Runs one admin form submission and reports its outcome on the page. */
const submit = <A, I extends Readonly<Record<string, string | undefined>>, E, R>(
  form: Schema.Codec<A, I>,
  run: (input: A) => Effect.Effect<string, E & { readonly message: string }, R>,
) =>
  HttpServerRequest.schemaBodyUrlParams(form).pipe(
    Effect.mapError(() => ({ message: "The form was incomplete." })),
    Effect.flatMap(run),
    Effect.match({
      onSuccess: (notice) => back({ notice }),
      onFailure: (error) => back({ error: error.message }),
    }),
  );

const Id = Schema.Struct({ id: Schema.String });

const routes = (mcpListen: string) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const query = new URL(request.url, "http://admin").searchParams;
        const state = yield* (yield* Registry).state;
        const health = yield* Effect.forEach(
          state.servers,
          (server) => check(server).pipe(Effect.map((result) => [server.id, result] as const)),
          { concurrency: "unbounded" },
        );
        return HttpServerResponse.html(
          renderPage({
            state,
            health: new Map(health),
            nowMs: DateTime.toEpochMillis(yield* DateTime.now),
            mcpListen,
            notice: query.get("notice"),
            error: query.get("error"),
          }),
        );
      }),
    ),
    HttpRouter.add(
      "POST",
      "/servers/pair",
      submit(Schema.Struct({ link: Schema.String, id: Schema.optional(Schema.String) }), (input) =>
        Effect.gen(function* () {
          const pairing = yield* pair(input.link);
          const state = yield* (yield* Registry).update((current) =>
            addServer(current, pairing, input.id?.trim() || undefined),
          );
          const added = state.servers.find(
            (server) => server.environmentId === pairing.environmentId,
          );
          return `Paired ${pairing.name} as "${added?.id}".`;
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/servers/repair",
      submit(Schema.Struct({ id: Schema.String, link: Schema.String }), (input) =>
        Effect.gen(function* () {
          const pairing = yield* pair(input.link);
          yield* (yield* Registry).update((current) => repairServer(current, input.id, pairing));
          return `Refreshed the token for "${input.id}".`;
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/servers/update",
      submit(
        Schema.Struct({ id: Schema.String, newId: Schema.String, name: Schema.String }),
        (input) =>
          Registry.use((registry) =>
            registry.update((current) =>
              updateServer(current, input.id, { id: input.newId.trim(), name: input.name }),
            ),
          ).pipe(Effect.as(`Saved "${input.newId.trim()}".`)),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/servers/toggle",
      submit(Id, (input) =>
        Registry.use((registry) =>
          registry.update((current) =>
            updateServer(current, input.id, {
              enabled: !current.servers.find((server) => server.id === input.id)?.enabled,
            }),
          ),
        ).pipe(
          Effect.map(
            (state) =>
              `${state.servers.find((server) => server.id === input.id)?.enabled ? "Enabled" : "Disabled"} "${input.id}".`,
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/servers/remove",
      submit(Id, (input) =>
        Registry.use((registry) =>
          registry.update((current) => removeServer(current, input.id)),
        ).pipe(
          Effect.as(
            `Removed "${input.id}". It stays listed in that server's Connections settings until its token expires; revoke it there to end access sooner.`,
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/settings",
      submit(Schema.Struct({ publicUrl: Schema.String }), (input) =>
        Registry.use((registry) =>
          registry.update((current) => setPublicUrl(current, input.publicUrl)),
        ).pipe(Effect.as("Saved the public URL.")),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/secret",
      Registry.use((registry) => registry.rotateSecret).pipe(
        Effect.match({
          onSuccess: () =>
            back({ notice: "Rotated the secret. Update the MCP URL in your MCP clients." }),
          onFailure: (error) => back({ error: error.message }),
        }),
      ),
    ),
  );

/**
 * The page shows the MCP secret and can pair servers, so it never caches or
 * frames, and a form post from another site is refused.
 */
const AdminGuard = HttpRouter.middleware()((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const site = request.headers["sec-fetch-site"];
    const origin = request.headers.origin;
    const crossSite =
      (site !== undefined && site !== "same-origin" && site !== "none") ||
      (origin !== undefined && origin !== "null" && new URL(origin).host !== request.headers.host);
    if (request.method !== "GET" && crossSite) {
      return HttpServerResponse.text("Cross-site request refused.", { status: 403 });
    }
    return HttpServerResponse.setHeaders(yield* httpEffect, {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
  }),
).layer;

export const layer = (mcpListen: string) => routes(mcpListen).pipe(Layer.provide(AdminGuard));
