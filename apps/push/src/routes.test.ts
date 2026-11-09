import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";

import * as Push from "./Push.ts";
import * as Routes from "./routes.ts";

const stubPush = (published: Array<string>) =>
  Layer.succeed(
    Push.Push,
    Push.Push.of({
      publish: (input) =>
        Effect.sync(() => {
          published.push(
            `${input.environmentId}/${input.threadId}:${input.state?.phase ?? "gone"}`,
          );
          return { ok: true, deliveries: [] };
        }),
      registerDevice: () => Effect.void,
      registerLiveActivity: () => Effect.void,
      unregisterDevice: () => Effect.void,
      snapshot: Effect.succeed({ aggregate: null }),
      sweepIdle: Effect.void,
    }),
  );

const HOST = "host-secret";
const PHONE = "phone-secret";

const state = (environmentId: string) => ({
  environmentId,
  threadId: "t1",
  projectTitle: "Project",
  threadTitle: "Thread",
  phase: "running",
  headline: "Working",
  modelTitle: "Model",
  updatedAt: "2026-11-08T00:00:00.000Z",
  deepLink: "/threads/t1",
});

const serve = (published: Array<string>) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        Routes.layer({ host: Redacted.make(HOST), phone: Redacted.make(PHONE) }).pipe(
          Layer.provideMerge(stubPush(published)),
        ),
        { disableLogger: true },
      ),
    ),
    ({ dispose }) => Effect.promise(dispose),
  ).pipe(
    Effect.map(
      ({ handler }) =>
        (input: {
          readonly method: string;
          readonly path: string;
          readonly token?: string;
          readonly body?: unknown;
        }) =>
          Effect.promise(() =>
            handler(
              new Request(`http://push.test${input.path}`, {
                method: input.method,
                headers: {
                  ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
                  ...(input.body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
              }),
            ),
          ).pipe(Effect.map((response) => response.status)),
    ),
  );

const publishPath = "/v1/environments/e1/threads/t1/agent-activity";
const device = {
  deviceId: "phone",
  label: "iPhone",
  platform: "ios",
  iosMajorVersion: 18,
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("t3-push routes", () => {
  it.effect("lets each token reach only its own endpoints", () =>
    Effect.gen(function* () {
      const published: Array<string> = [];
      const call = yield* serve(published);
      const cases = [
        { method: "GET", path: "/healthz", status: 200 },
        {
          method: "POST",
          path: publishPath,
          body: { state: state("e1"), proof: "p" },
          status: 401,
        },
        {
          method: "POST",
          path: publishPath,
          token: PHONE,
          body: { state: state("e1"), proof: "p" },
          status: 401,
        },
        {
          method: "POST",
          path: publishPath,
          token: `${HOST}x`,
          body: { state: null, proof: "p" },
          status: 401,
        },
        {
          method: "POST",
          path: publishPath,
          token: HOST,
          body: { state: state("e1"), proof: "p" },
          status: 200,
        },
        {
          method: "POST",
          path: publishPath,
          token: HOST,
          body: { state: null, proof: "p" },
          status: 200,
        },
        {
          method: "POST",
          path: publishPath,
          token: HOST,
          body: { state: state("e2"), proof: "p" },
          status: 400,
        },
        { method: "POST", path: publishPath, token: HOST, body: { proof: "p" }, status: 400 },
        { method: "POST", path: "/v1/mobile/devices", token: HOST, body: device, status: 401 },
        { method: "POST", path: "/v1/mobile/devices", token: PHONE, body: device, status: 200 },
        {
          method: "POST",
          path: "/v1/mobile/live-activities",
          token: PHONE,
          body: { deviceId: "phone", activityPushToken: "token" },
          status: 200,
        },
        { method: "GET", path: "/v1/mobile/agent-activity", token: HOST, status: 401 },
        { method: "GET", path: "/v1/mobile/agent-activity", token: PHONE, status: 200 },
        { method: "DELETE", path: "/v1/mobile/devices/phone", token: PHONE, status: 200 },
      ] as const;
      for (const { status, ...request } of cases) {
        expect([request.method, request.path, yield* call(request)]).toEqual([
          request.method,
          request.path,
          status,
        ]);
      }
      expect(published).toEqual(["e1/t1:running", "e1/t1:gone"]);
    }),
  );
});
