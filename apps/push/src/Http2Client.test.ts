// @effect-diagnostics nodeBuiltinImport:off -- The fixture is a real HTTP/2 server.
import * as NodeHttp2 from "node:http2";
import type * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as Http2Client from "./Http2Client.ts";

interface Received {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly topic: string | undefined;
  readonly body: string;
}

/** A cleartext HTTP/2 server that answers like APNs refusing a retired token. */
const apnsLike = Effect.acquireRelease(
  Effect.callback<{
    readonly origin: string;
    readonly received: Array<Received>;
    readonly sessions: () => number;
    readonly server: NodeHttp2.Http2Server;
  }>((resume) => {
    const received: Array<Received> = [];
    let sessions = 0;
    const server = NodeHttp2.createServer();
    server.on("session", () => (sessions += 1));
    server.on("stream", (stream, headers) => {
      const chunks: Array<Buffer> = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        received.push({
          method: headers[":method"],
          path: headers[":path"],
          topic: headers["apns-topic"] as string | undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        stream.respond({ ":status": 410, "apns-id": "apns-1" });
        stream.end(JSON.stringify({ reason: "Unregistered" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      resume(
        Effect.succeed({
          origin: `http://127.0.0.1:${port}`,
          received,
          sessions: () => sessions,
          server,
        }),
      );
    });
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
);

describe("Http2Client", () => {
  it.live("sends over one reused HTTP/2 session and returns APNs' status, headers and body", () =>
    Effect.gen(function* () {
      const apns = yield* apnsLike;
      const client = yield* HttpClient.HttpClient;
      const send = (token: string) =>
        HttpClientRequest.post(`${apns.origin}/3/device/${token}`).pipe(
          HttpClientRequest.setHeaders({ "apns-topic": "codes.t3.test" }),
          HttpClientRequest.bodyJsonUnsafe({ aps: { event: "update" } }),
          client.execute,
          Effect.flatMap((response) =>
            response.text.pipe(
              Effect.map((text) => ({
                status: response.status,
                apnsId: response.headers["apns-id"],
                text,
              })),
            ),
          ),
        );
      const responses = [yield* send("a"), yield* send("b")];

      expect(responses).toEqual([
        { status: 410, apnsId: "apns-1", text: '{"reason":"Unregistered"}' },
        { status: 410, apnsId: "apns-1", text: '{"reason":"Unregistered"}' },
      ]);
      expect(apns.received).toEqual([
        {
          method: "POST",
          path: "/3/device/a",
          topic: "codes.t3.test",
          body: '{"aps":{"event":"update"}}',
        },
        {
          method: "POST",
          path: "/3/device/b",
          topic: "codes.t3.test",
          body: '{"aps":{"event":"update"}}',
        },
      ]);
      expect(apns.sessions()).toBe(1);
    }).pipe(Effect.provide(Http2Client.layer)),
  );
});
