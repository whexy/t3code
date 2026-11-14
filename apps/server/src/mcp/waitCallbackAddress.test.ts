import { describe, expect, it } from "@effect/vitest";

import { callbackUrlProblem, isBlockedCallbackAddress } from "./waitCallbackAddress.ts";

describe("isBlockedCallbackAddress", () => {
  it.each([
    ["127.0.0.1", true],
    ["0.0.0.0", true],
    ["::1", true],
    ["::", true],
    ["::ffff:127.0.0.1", true],
    ["169.254.169.254", true],
    ["fd00:ec2::254", true],
    ["fe80::1", true],
    ["224.0.0.251", true],
    ["not-an-address", true],
    ["10.0.0.5", false],
    ["192.168.1.20", false],
    ["100.101.102.103", false],
    ["8.8.8.8", false],
    ["::ffff:8.8.8.8", false],
    ["2606:4700::1111", false],
  ])("%s blocked: %s", (address, blocked) => {
    expect(isBlockedCallbackAddress(address)).toBe(blocked);
  });
});

describe("callbackUrlProblem", () => {
  it.each([
    ["https://hooks.example.com/t3?k=1", undefined],
    ["https://100.101.102.103:8443/hook", undefined],
    ["http://hooks.example.com/t3", "callback.url must use https."],
    ["not a url", "callback.url is not a URL."],
    ["https://127.0.0.1/hook", "callback.url points at 127.0.0.1, which callbacks may not reach."],
    ["https://[::1]/hook", "callback.url points at ::1, which callbacks may not reach."],
  ])("%s", (url, problem) => {
    expect(callbackUrlProblem(url)).toBe(problem);
  });
});
