import { describe, expect, it } from "vite-plus/test";

import { createFreshSideChats } from "./freshSideChats";

describe("createFreshSideChats", () => {
  it("abandons a fresh side chat only once its last screen leaves", () => {
    const fresh = createFreshSideChats();
    fresh.mark("a");
    fresh.enter("a");
    // Maximizing mounts the full-screen copy before the inspector copy unmounts.
    fresh.enter("a");
    fresh.leave("a");
    expect(fresh.takeAbandoned("a")).toBe(false);
    fresh.leave("a");
    expect(fresh.takeAbandoned("a")).toBe(true);
    expect(fresh.takeAbandoned("a")).toBe(false);
  });

  it("never abandons a side chat this device did not start empty", () => {
    const fresh = createFreshSideChats();
    fresh.enter("b");
    fresh.leave("b");
    expect(fresh.takeAbandoned("b")).toBe(false);
  });
});
