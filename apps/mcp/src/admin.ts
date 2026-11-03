import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { check, pair } from "./access.ts";
import { adminCss } from "./adminCss.ts";
import { renderPage, serverPath, type View } from "./adminView.ts";
import {
  addServer,
  Registry,
  removeServer,
  repairServer,
  setPublicUrl,
  updateServer,
} from "./registry.ts";

const back = (path: string, message: { readonly notice: string } | { readonly error: string }) =>
  HttpServerResponse.redirect(`${path}?${new URLSearchParams(message)}`, { status: 303 });

/**
 * Runs one admin form submission and reports its outcome on a page: the
 * outcome's page on success, and the page holding the form on failure.
 */
const submit = <A, I extends Readonly<Record<string, string | undefined>>, E, R>(
  form: Schema.Codec<A, I>,
  from: (input: A) => string,
  run: (
    input: A,
  ) => Effect.Effect<
    { readonly notice: string; readonly to: string },
    E & { readonly message: string },
    R
  >,
) =>
  HttpServerRequest.schemaBodyUrlParams(form).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(back("/", { error: "The form was incomplete." })),
      onSuccess: (input) =>
        run(input).pipe(
          Effect.match({
            onSuccess: ({ notice, to }) => back(to, { notice }),
            onFailure: (error) => back(from(input), { error: error.message }),
          }),
        ),
    }),
  );

const Id = Schema.Struct({ id: Schema.String });
const fromServer = (input: { readonly id: string }) => serverPath(input.id);

const routes = (mcpListen: string, css: string) => {
  const stylesheet = `/admin.css?v=${(Hash.string(css) >>> 0).toString(36)}`;

  /** Renders one group of the page; each group is its own URL, so a reload keeps the place. */
  const page = Effect.fn("Admin.page")(function* <E, R>(view: Effect.Effect<View, E, R>) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = new URL(request.url, "http://admin").searchParams;
    const rendered = yield* view;
    const html = HttpServerResponse.html(
      renderPage(
        {
          state: yield* (yield* Registry).state,
          nowMs: DateTime.toEpochMillis(yield* DateTime.now),
          notice: query.get("notice"),
          error: query.get("error"),
          stylesheet,
        },
        rendered,
      ),
    );
    return rendered.kind === "missing" ? HttpServerResponse.setStatus(html, 404) : html;
  });

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/admin.css",
      Effect.succeed(
        HttpServerResponse.text(css, {
          contentType: "text/css; charset=utf-8",
          headers: { "cache-control": "public, max-age=31536000, immutable" },
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/",
      page(
        Effect.gen(function* () {
          const state = yield* (yield* Registry).state;
          const health = yield* Effect.forEach(
            state.servers,
            (server) => check(server).pipe(Effect.map((result) => [server.id, result] as const)),
            { concurrency: "unbounded" },
          );
          return { kind: "servers", health: new Map(health) } as const;
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/servers/:id",
      page(
        Effect.gen(function* () {
          const id = (yield* HttpRouter.params).id ?? "";
          const server = (yield* (yield* Registry).state).servers.find(
            (candidate) => candidate.id === id,
          );
          if (server === undefined) return { kind: "missing", id } as const;
          return { kind: "server", server, health: yield* check(server) } as const;
        }),
      ),
    ),
    HttpRouter.add("GET", "/pair", page(Effect.succeed({ kind: "pair" } as const))),
    HttpRouter.add(
      "GET",
      "/endpoint",
      page(Effect.succeed({ kind: "endpoint", mcpListen } as const)),
    ),
    HttpRouter.add(
      "POST",
      "/servers/pair",
      submit(
        Schema.Struct({ link: Schema.String, id: Schema.optional(Schema.String) }),
        () => "/pair",
        (input) =>
          Effect.gen(function* () {
            const pairing = yield* pair(input.link);
            const state = yield* (yield* Registry).update((current) =>
              addServer(current, pairing, input.id?.trim() || undefined),
            );
            const added = state.servers.find(
              (server) => server.environmentId === pairing.environmentId,
            );
            return {
              notice: `Paired ${pairing.name} as "${added?.id}".`,
              to: added === undefined ? "/" : serverPath(added.id),
            };
          }),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/servers/repair",
      submit(Schema.Struct({ id: Schema.String, link: Schema.String }), fromServer, (input) =>
        Effect.gen(function* () {
          const pairing = yield* pair(input.link);
          yield* (yield* Registry).update((current) => repairServer(current, input.id, pairing));
          return { notice: `Refreshed the token for "${input.id}".`, to: serverPath(input.id) };
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/servers/update",
      submit(
        Schema.Struct({ id: Schema.String, newId: Schema.String, name: Schema.String }),
        fromServer,
        (input) =>
          Registry.use((registry) =>
            registry.update((current) =>
              updateServer(current, input.id, { id: input.newId.trim(), name: input.name }),
            ),
          ).pipe(
            Effect.as({
              notice: `Saved "${input.newId.trim()}".`,
              to: serverPath(input.newId.trim()),
            }),
          ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/servers/toggle",
      submit(Id, fromServer, (input) =>
        Registry.use((registry) =>
          registry.update((current) =>
            updateServer(current, input.id, {
              enabled: !current.servers.find((server) => server.id === input.id)?.enabled,
            }),
          ),
        ).pipe(
          Effect.map((state) => ({
            notice: `${state.servers.find((server) => server.id === input.id)?.enabled ? "Enabled" : "Disabled"} "${input.id}".`,
            to: serverPath(input.id),
          })),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/servers/remove",
      submit(Id, fromServer, (input) =>
        Registry.use((registry) =>
          registry.update((current) => removeServer(current, input.id)),
        ).pipe(
          Effect.as({
            notice: `Removed "${input.id}". It stays listed in that server's Connections settings until its token expires; revoke it there to end access sooner.`,
            to: "/",
          }),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/settings",
      submit(
        Schema.Struct({ publicUrl: Schema.String }),
        () => "/endpoint",
        (input) =>
          Registry.use((registry) =>
            registry.update((current) => setPublicUrl(current, input.publicUrl)),
          ).pipe(Effect.as({ notice: "Saved the public URL.", to: "/endpoint" })),
      ),
    ),
  );
};

/**
 * The page can pair servers, so it never caches or frames, and a form post
 * from another site is refused. Only the stylesheet, versioned by its
 * content, sets its own caching.
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
    const response = yield* httpEffect;
    return HttpServerResponse.setHeaders(response, {
      "cache-control": response.headers["cache-control"] ?? "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
  }),
).layer;

export const layer = (mcpListen: string) =>
  Effect.promise(adminCss).pipe(
    Effect.map((css) => routes(mcpListen, css)),
    Layer.unwrap,
    Layer.provide(AdminGuard),
  );
