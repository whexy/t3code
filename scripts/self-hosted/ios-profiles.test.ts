import { expect, it } from "vite-plus/test";

import { selectProfiles } from "./ios-profiles.ts";

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
