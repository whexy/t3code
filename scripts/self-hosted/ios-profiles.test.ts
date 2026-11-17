import { expect, it } from "vite-plus/test";

import { fetchWithRetry, selectProfiles } from "./ios-profiles.ts";

const answers = (...outcomes: ReadonlyArray<number | Error>) => {
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request) => {
    calls.push(String(url));
    const outcome = outcomes[calls.length - 1];
    if (outcome === undefined) throw new Error("no more answers");
    if (outcome instanceof Error) throw outcome;
    return new Response(null, { status: outcome });
  };
  return { calls, fetch };
};
const noWait = { delaysMs: [1, 2, 3], sleep: async () => {} };

it("waits out App Store Connect's 5xx, 429 and dropped connections", async () => {
  const { calls, fetch } = answers(500, new TypeError("fetch failed"), 429, 200);
  const response = await fetchWithRetry("https://asc/profiles", {}, { ...noWait, fetch });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(4);
});

it("returns any other answer, and the last 5xx, without asking again", async () => {
  const forbidden = answers(403);
  expect(
    (await fetchWithRetry("https://asc", {}, { ...noWait, fetch: forbidden.fetch })).status,
  ).toBe(403);
  expect(forbidden.calls).toHaveLength(1);

  const down = answers(500, 502, 503, 500);
  expect((await fetchWithRetry("https://asc", {}, { ...noWait, fetch: down.fetch })).status).toBe(
    500,
  );
  expect(down.calls).toHaveLength(4);
});

const profile = (bundleIdentifier: string, uuid: string, expirationDate: string) => ({
  uuid,
  bundleIdentifier,
  expirationDate,
  content: "",
});

it("signs each bundle with its newest profile", () => {
  const selected = selectProfiles(
    ["dev.whexy.t3code", "dev.whexy.t3code.widgets"],
    [
      profile("dev.whexy.t3code", "old", "2027-01-01T00:00:00.000+00:00"),
      profile("dev.whexy.t3code", "new", "2027-11-08T00:00:00.000+00:00"),
      profile("dev.whexy.t3code.widgets", "widgets", "2027-11-08T00:00:00.000+00:00"),
    ],
  );
  expect([...selected].map(([identifier, { uuid }]) => [identifier, uuid])).toEqual([
    ["dev.whexy.t3code", "new"],
    ["dev.whexy.t3code.widgets", "widgets"],
  ]);
});

// An extension upstream adds later has no profile until someone creates one.
it("names every bundle that has no profile", () => {
  expect(() =>
    selectProfiles(
      ["dev.whexy.t3code", "dev.whexy.t3code.clip", "dev.whexy.t3code.intents"],
      [profile("dev.whexy.t3code", "app", "2027-11-08T00:00:00.000+00:00")],
    ),
  ).toThrow("No active App Store profile for dev.whexy.t3code.clip, dev.whexy.t3code.intents.");
});
