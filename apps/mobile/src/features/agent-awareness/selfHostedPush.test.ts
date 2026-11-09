import { describe, expect, it, vi } from "vite-plus/test";

import { resolveSelfHostedPushConfig } from "./selfHostedPush";

vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));

describe("resolveSelfHostedPushConfig", () => {
  it.each([
    ["no native module", null, null],
    ["no Info.plist keys", { url: null, token: null }, null],
    ["a URL without a token", { url: "https://push.example.test", token: " " }, null],
    ["a token without a URL", { token: "phone-token" }, null],
    ["an insecure URL", { url: "http://push.example.test", token: "phone-token" }, null],
    [
      "a URL and a token",
      { url: "https://push.example.test/", token: " phone-token " },
      { url: "https://push.example.test", token: "phone-token" },
    ],
  ])("resolves %s", (_case, native, expected) => {
    expect(resolveSelfHostedPushConfig(native)).toEqual(expected);
  });
});
