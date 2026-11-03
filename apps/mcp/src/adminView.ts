import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";

import type { ServerHealth } from "./access.ts";
import type { BridgeState, ServerRecord } from "./registry.ts";

const DAY_MS = 86_400_000;
const EXPIRY_WARNING_DAYS = 7;

const FONTS =
  "https://fonts.googleapis.com/css2?family=Fira+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&family=Lato:wght@400;700&display=swap";

export const serverPath = (id: string) => `/servers/${encodeURIComponent(id)}`;

export type View =
  | { readonly kind: "servers"; readonly health: ReadonlyMap<string, ServerHealth> }
  | { readonly kind: "server"; readonly server: ServerRecord; readonly health: ServerHealth }
  | { readonly kind: "missing"; readonly id: string }
  | { readonly kind: "pair" }
  | { readonly kind: "endpoint"; readonly mcpListen: string };

export interface Shell {
  readonly state: BridgeState;
  readonly nowMs: number;
  readonly notice: string | null;
  readonly error: string | null;
  readonly stylesheet: string;
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const FIELD = `w-full min-w-0 rounded-xl border border-black/10 bg-white/80 px-3 py-2 text-sm font-normal text-ink placeholder:text-ink-faint ${FOCUS}`;
const INPUT = `${FIELD} font-sans`;
const LABEL = "grid gap-1.5 font-title text-sm font-medium text-ink-glass";
const HINT = "leading-relaxed text-ink-muted";
const H2 = "font-title text-base font-bold text-ink-glass";

function healthLabel(health: ServerHealth | undefined, nowMs: number) {
  switch (health?.status) {
    case "connected": {
      if (health.missing.length > 0) {
        return {
          text: "Connected without some permissions · re-pair",
          attention: true,
          detail: `missing ${health.missing.join(", ")}`,
        };
      }
      if (health.expiresAt === null) return { text: "Connected", attention: false };
      const days = Math.floor((Date.parse(health.expiresAt) - nowMs) / DAY_MS);
      return {
        text: `Connected · token expires ${days < 1 ? "within a day" : `in ${days} days`}`,
        attention: days < EXPIRY_WARNING_DAYS,
      };
    }
    case "too_old":
      return {
        text: "Automatically disabled because the server is too old",
        attention: true,
        detail: `T3 Code ${health.serverVersion}`,
      };
    case "rejected":
      return { text: "Token rejected · re-pair", attention: true };
    case "unreachable":
      return { text: "Unreachable", attention: true, detail: health.detail };
    default:
      return { text: "Unknown", attention: true };
  }
}

/** Status has no color in Frost: a problem reads as solid ink and heavier text. */
function statusLine(server: ServerRecord, health: ServerHealth | undefined, nowMs: number) {
  const label = healthLabel(health, nowMs);
  const off = server.enabled
    ? health?.status === "too_old"
      ? "hidden from tools until it is updated"
      : null
    : "disabled, hidden from tools";
  return `<p class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
    <span aria-hidden="true" class="${label.attention ? "bg-ink" : "bg-ink-faint"} relative -top-px inline-block h-2 w-2 shrink-0 rounded-full"></span>
    <span class="${label.attention ? "font-semibold text-ink" : "text-ink-subtle"}">${escape(label.text)}</span>
    ${"detail" in label ? `<span class="min-w-0 break-words text-ink-muted">${escape(label.detail)}</span>` : ""}
    ${off === null ? "" : `<span class="text-ink-muted">· ${off}</span>`}
  </p>`;
}

/** What the server lets the bridge's token do, as T3 Code's Connections settings list it. */
function permissions(health: ServerHealth) {
  if (health.status !== "connected") return "";
  const rows = AUTH_SCOPE_OPTIONS.map(({ scope, title }) => {
    const allowed = health.granted.includes(scope);
    const needed = health.missing.includes(scope);
    const tone = allowed ? "text-ink-soft" : needed ? "font-semibold text-ink" : "text-ink-faint";
    return `<li class="flex justify-between gap-3 py-1"><span class="text-ink-glass">${escape(title)}</span><span class="${tone} whitespace-nowrap">${allowed ? "Allowed" : "Not granted"}</span></li>`;
  }).join("");
  return `<div class="space-y-2 border-t border-black/5 pt-5">
    <h2 class="${H2}">Permissions <span class="font-sans text-sm font-normal text-ink-muted">· ${health.granted.length} of ${AUTH_SCOPE_OPTIONS.length} allowed</span></h2>
    <p class="${HINT}">These permissions apply to the bridge's token on this server.</p>
    <ul class="grid gap-x-8 sm:grid-cols-2">${rows}</ul>
  </div>`;
}

const button = (
  action: string,
  label: string,
  fields: Record<string, string>,
  options: { readonly confirm?: string } = {},
) =>
  `<form method="post" action="${action}"${options.confirm ? ` onsubmit="return confirm('${escape(options.confirm)}')"` : ""}>${Object.entries(
    fields,
  )
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(value)}">`)
    .join("")}<button class="btn-glass">${label}</button></form>`;

/** A page-level glass surface: square and edge to edge on phones. */
const card = (body: string) =>
  `<section class="glass-card p-6 max-sm:rounded-none">
  <div class="glass-tint from-blue-100/30 via-purple-50/20 to-pink-100/30"></div>
  <div class="relative z-10 space-y-5">${body}</div>
</section>`;

const heading = (title: string, meta = "") =>
  `<header class="space-y-1 px-4 sm:px-2">
  <h1 class="font-title text-2xl leading-tight font-bold tracking-tight text-ink">${title}</h1>
  ${meta}
</header>`;

function navLink(href: string, label: string, current: boolean, trailing = "", muted = false) {
  const tone = current
    ? "bg-white/40 font-semibold text-ink-strong shadow-sm"
    : `${muted ? "text-ink-muted" : "text-ink-soft"} hover:bg-white/20 hover:text-ink-strong`;
  return `<li><a href="${href}"${current ? ` aria-current="page"` : ""} class="${tone} flex items-center gap-3 rounded-xl px-3 py-2 font-title text-sm transition-all duration-200 ${FOCUS}"><span class="min-w-0 truncate">${label}</span>${trailing}</a></li>`;
}

const NAV_GROUP = "px-3 pt-4 pb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase";
const NAV_LIST = "flex flex-wrap gap-1 md:block md:space-y-0.5";

function nav(state: BridgeState, view: View) {
  const servers = state.servers
    .map((server) =>
      navLink(
        serverPath(server.id),
        escape(server.name),
        view.kind === "server" && view.server.id === server.id,
        "",
        !server.enabled,
      ),
    )
    .join("");
  return `<nav aria-label="Bridge" class="glass-card w-full shrink-0 p-3 max-sm:rounded-none md:sticky md:top-10 md:w-56">
  <div class="glass-tint from-blue-100/30 via-purple-50/20 to-pink-100/30"></div>
  <div class="glow-blob top-4 left-4 h-24 w-24 from-blue-200/20 to-cyan-200/20 blur-xl"></div>
  <div class="glow-blob right-6 bottom-4 h-20 w-20 from-purple-200/15 to-pink-200/15 blur-lg"></div>
  <div class="glass-shine"></div>
  <div class="relative z-10">
    <a href="/" class="block rounded-xl px-3 py-1 font-title text-lg font-bold tracking-tight text-ink ${FOCUS}">T3 Code MCP bridge</a>
    <p class="${NAV_GROUP}">Servers</p>
    <ul class="${NAV_LIST}">
      ${navLink("/", "All servers", view.kind === "servers", `<span class="ml-auto font-sans text-xs font-normal text-ink-muted">${state.servers.length}</span>`)}
      ${servers}
      ${navLink("/pair", "Pair a server", view.kind === "pair")}
    </ul>
    <p class="${NAV_GROUP}">Connection</p>
    <ul class="${NAV_LIST}">
      ${navLink("/endpoint", "MCP endpoint", view.kind === "endpoint")}
    </ul>
  </div>
</nav>`;
}

function serversView(shell: Shell, health: ReadonlyMap<string, ServerHealth>) {
  const { state } = shell;
  if (state.servers.length === 0) {
    return `${heading("Servers")}
${card(`<p class="text-ink-muted">No servers yet.</p><div><a href="/pair" class="btn-solid inline-flex">Pair a server</a></div>`)}`;
  }
  const rows = state.servers
    .map(
      (
        server,
      ) => `<li><a href="${serverPath(server.id)}" class="block space-y-1 rounded-2xl px-4 py-3 transition-all duration-200 hover:bg-white/20 ${FOCUS}">
  <div class="${server.enabled ? "" : "opacity-60"} flex min-w-0 flex-wrap items-baseline gap-x-2">
    <span class="font-title text-base font-bold text-ink-glass">${escape(server.name)}</span>
    <code class="font-mono text-xs text-ink-muted">${escape(server.id)}</code>
    <span class="min-w-0 basis-full truncate text-ink-muted">${escape(server.url)}</span>
  </div>
  ${statusLine(server, health.get(server.id), shell.nowMs)}
</a></li>`,
    )
    .join("");
  return `${heading(`Servers <span class="font-sans text-base font-normal text-ink-muted">· ${state.servers.length}</span>`)}
<section class="glass-card p-2 max-sm:rounded-none">
  <div class="glass-tint from-blue-100/30 via-purple-50/20 to-pink-100/30"></div>
  <ul class="relative z-10 space-y-1">${rows}</ul>
</section>`;
}

function serverView(shell: Shell, server: ServerRecord, health: ServerHealth) {
  const id = escape(server.id);
  const disabled = !server.enabled || health.status === "too_old";
  return `${heading(
    `${escape(server.name)}`,
    `<p class="${disabled ? "opacity-60" : ""} flex min-w-0 flex-wrap items-baseline gap-x-2 text-ink-muted"><code class="font-mono text-xs">${id}</code><span class="min-w-0 break-all">${escape(server.url)}</span></p>`,
  )}
${card(`<div class="flex items-start justify-between gap-3">
    <div class="min-w-0 flex-1 pt-2">${statusLine(server, health, shell.nowMs)}</div>
    ${button("/servers/toggle", server.enabled ? "Disable" : "Enable", { id: server.id })}
  </div>
  ${permissions(health)}`)}
${card(`<form method="post" action="/servers/update" class="space-y-3">
    <h2 class="${H2}">Name and id</h2>
    <input type="hidden" name="id" value="${id}">
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="${LABEL}">Name <input class="${INPUT}" name="name" value="${escape(server.name)}" required></label>
      <label class="${LABEL}">Server id <input class="${INPUT}" name="newId" value="${id}" required pattern="[a-z0-9][a-z0-9_-]*"></label>
    </div>
    <p class="${HINT}">The id is the <code class="font-mono text-xs">server_id</code> chats use. Changing it breaks session ids a chat already holds for this server.</p>
    <div><button class="btn-solid">Save</button></div>
  </form>
  <form method="post" action="/servers/repair" class="space-y-3 border-t border-black/5 pt-5">
    <h2 class="${H2}">Re-pair</h2>
    <input type="hidden" name="id" value="${id}">
    <label class="${LABEL}">New pairing link <input class="${INPUT}" name="link" required placeholder="https://…/pair#token=…"></label>
    <div><button class="btn-glass">Re-pair</button></div>
  </form>
  <div class="flex flex-wrap items-center justify-between gap-3 border-t border-black/5 pt-5">
    <p class="${HINT}">The bridge forgets this server's token.</p>
    ${button("/servers/remove", "Remove server", { id: server.id }, { confirm: `Remove ${server.id}? The bridge forgets its token.` })}
  </div>`)}`;
}

const pairView = () => `${heading("Pair a server")}
${card(`<form method="post" action="/servers/pair" class="space-y-3">
    <div class="grid gap-3 sm:grid-cols-3">
      <label class="${LABEL} sm:col-span-2">Pairing link <input class="${INPUT}" name="link" required placeholder="https://…/pair#token=…"></label>
      <label class="${LABEL}">Server id (optional) <input class="${INPUT}" name="id" pattern="[a-z0-9][a-z0-9_-]*" placeholder="from the server's name"></label>
    </div>
    <p class="${HINT}">In T3 Code, open Settings → Connections on that server and create a pairing link. Links work once and expire after a few minutes. The bridge asks only to view and operate tasks, read usage, and change source control, and tokens last 30 days.</p>
    <div><button class="btn-solid">Pair</button></div>
  </form>`)}`;

function endpointView(shell: Shell, mcpListen: string) {
  const { state } = shell;
  const endpoint =
    state.publicUrl === null
      ? `<p class="font-semibold text-ink">Set the public URL below to see the full MCP endpoint.</p>`
      : `<div class="flex gap-2">
      <input id="endpoint" readonly value="${escape(`${state.publicUrl}/mcp`)}" aria-label="MCP endpoint" class="${FIELD} font-mono">
      <button type="button" class="btn-solid" onclick="navigator.clipboard.writeText(document.getElementById('endpoint').value).then(()=>{this.textContent='Copied';setTimeout(()=>{this.textContent='Copy'},1500)})">Copy</button>
    </div>
    <p class="${HINT}">In ChatGPT or Claude, add a custom connector with this URL and OAuth, leaving the client ID and secret empty. The connector registers with Cloudflare Access, which signs you in.</p>`;
  return `${heading("MCP endpoint")}
${card(`<div class="space-y-3">${endpoint}</div>
  <form method="post" action="/settings" class="space-y-3 border-t border-black/5 pt-5">
    <div class="flex flex-wrap items-end gap-2">
      <label class="${LABEL} min-w-0 flex-1 basis-64">Public URL <input class="${INPUT}" name="publicUrl" type="url" value="${escape(state.publicUrl ?? "")}" placeholder="https://t3-mcp.example.com"></label>
      <button class="btn-glass">Save</button>
    </div>
    <p class="${HINT}">The MCP listener is <code class="font-mono text-xs">${escape(mcpListen)}</code>. Route only <code class="font-mono text-xs">/mcp</code> on your public hostname to it, behind the Cloudflare Access application the bridge checks.</p>
  </form>`)}`;
}

const missingView = (id: string) => `${heading(`No server “${escape(id)}”`)}
${card(`<p class="text-ink-muted">It may have been renamed or removed.</p><div><a href="/" class="btn-glass inline-flex">All servers</a></div>`)}`;

function content(shell: Shell, view: View) {
  switch (view.kind) {
    case "servers":
      return { title: "Servers", body: serversView(shell, view.health) };
    case "server":
      return { title: view.server.name, body: serverView(shell, view.server, view.health) };
    case "missing":
      return { title: "No such server", body: missingView(view.id) };
    case "pair":
      return { title: "Pair a server", body: pairView() };
    case "endpoint":
      return { title: "MCP endpoint", body: endpointView(shell, view.mcpListen) };
  }
}

const banner = (role: "status" | "alert", text: string) =>
  `<p role="${role}" class="glass-card px-6 py-4 max-sm:rounded-none ${role === "alert" ? "font-semibold text-ink" : "font-medium text-ink-glass"}">${escape(text)}</p>`;

export function renderPage(shell: Shell, view: View) {
  const { title, body } = content(shell, view);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · T3 Code MCP bridge</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="${shell.stylesheet}">
</head>
<body class="font-sans text-sm text-ink antialiased">
<div class="flex flex-col gap-4 py-4 sm:px-4 sm:py-10 md:flex-row md:items-start md:justify-center md:gap-8">
${nav(shell.state, view)}
<main class="w-full max-w-content min-w-0 space-y-4">
${shell.notice ? banner("status", shell.notice) : ""}
${shell.error ? banner("alert", shell.error) : ""}
${body}
</main>
</div>
</body>
</html>`;
}
