// @effect-diagnostics nodeBuiltinImport:off -- APNs requires HTTP/2, which only node:http2 provides here.
import * as NodeHttp2 from "node:http2";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * An HttpClient over node:http2 with one reused session per origin. APNs
 * accepts only HTTP/2 and asks providers to keep connections open. It buffers
 * whole bodies: APNs requests and responses are a few kilobytes at most.
 */
export const layer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const sessions = new Map<string, NodeHttp2.ClientHttp2Session>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const session of sessions.values()) session.close();
        sessions.clear();
      }),
    );

    const sessionFor = (origin: string) => {
      const existing = sessions.get(origin);
      if (existing && !existing.closed && !existing.destroyed) return existing;
      const session = NodeHttp2.connect(origin);
      const forget = () => {
        if (sessions.get(origin) === session) sessions.delete(origin);
      };
      // Session errors also fail every open stream, which reports them.
      session.on("error", forget);
      session.on("goaway", forget);
      session.on("close", forget);
      // An idle connection must not keep the process alive.
      session.unref();
      sessions.set(origin, session);
      return session;
    };

    return HttpClient.make((request, url) =>
      Effect.callback<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>(
        (resume) => {
          let settled = false;
          const settle: typeof resume = (effect) => {
            if (settled) return;
            settled = true;
            resume(effect);
          };
          const fail = (cause: unknown) =>
            settle(
              Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request, cause }),
                }),
              ),
            );
          const body = request.body;
          if (body._tag !== "Empty" && body._tag !== "Uint8Array") {
            fail(new Error(`Unsupported request body: ${body._tag}`));
            return;
          }
          let stream: NodeHttp2.ClientHttp2Stream;
          try {
            stream = sessionFor(url.origin).request({
              ...request.headers,
              ":method": request.method,
              ":path": `${url.pathname}${url.search}`,
              ...(body._tag === "Uint8Array"
                ? { "content-type": body.contentType, "content-length": body.body.byteLength }
                : {}),
            });
          } catch (cause) {
            fail(cause);
            return;
          }
          let status = 0;
          const headers = new Headers();
          const chunks: Array<Buffer> = [];
          stream.on("response", (responseHeaders) => {
            status = Number(responseHeaders[":status"]);
            for (const [name, value] of Object.entries(responseHeaders)) {
              if (name.startsWith(":") || value === undefined) continue;
              headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
            }
          });
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () =>
            settle(
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(status === 204 ? null : Buffer.concat(chunks), {
                    status,
                    headers,
                  }),
                ),
              ),
            ),
          );
          stream.on("error", fail);
          stream.on("close", () => fail(new Error("HTTP/2 stream closed before its response")));
          stream.end(body._tag === "Uint8Array" ? body.body : undefined);
          return Effect.sync(() => {
            if (!stream.closed) stream.close(NodeHttp2.constants.NGHTTP2_CANCEL);
          });
        },
      ),
    );
  }),
);
