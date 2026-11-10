import { expect, it } from "vite-plus/test";

import { desktopReleaseNotes } from "./desktop-release-notes.ts";

const upstream = `**v0.1.9-nightly.20261110.4465** · 31 changes from 8 contributors

- **Faster response streaming.** See completed paragraphs sooner.

### Plus 25 more bug fixes and performance improvements.

<details>
<summary>Full changelog</summary>

* fix(server): something by @someone
</details>
`;

it("adds new user-facing fork commits above upstream's full changelog", () => {
  expect(
    desktopReleaseNotes(
      upstream,
      [
        "feat(brand): replace the T3 mark with W4 on every icon surface",
        "fix(web): sidebar keeps its width",
        "feat(web): shipped in the previous release",
        "fix(mobile): only on phones",
        "fix(ci): skip the desktop build when its release already exists",
        "ci(self-hosted): merge pull requests into dev",
        "chore(nix): pin sources for v0.1.9-nightly.20261110.4465",
      ],
      [
        "feat(web): shipped in the previous release",
        "chore(nix): pin sources for an older nightly",
      ],
    ),
  ).toBe(`**v0.1.9-nightly.20261110.4465** · 31 changes from 8 contributors

- **Faster response streaming.** See completed paragraphs sooner.

### Plus 25 more bug fixes and performance improvements.

### In this fork

- **Fork.** Replace the T3 mark with W4 on every icon surface
- **Fork.** Sidebar keeps its width

<details>
<summary>Full changelog</summary>

* fix(server): something by @someone
</details>
`);
});

it("passes upstream's notes through when the fork adds nothing user-facing", () => {
  expect(desktopReleaseNotes(upstream, ["chore(nix): pin sources"], [])).toBe(upstream);
});

it("leads with fork commits when upstream has no folded changelog", () => {
  expect(desktopReleaseNotes("## What's Changed\n* fix: a", ["fix: b"], [])).toBe(
    "### In this fork\n\n- **Fork.** B\n\n## What's Changed\n* fix: a\n",
  );
});
