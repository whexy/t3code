import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { expect, it } from "vite-plus/test";

const script = NodeURL.fileURLToPath(new URL("./rebase.sh", import.meta.url));
const older = "v0.0.1-nightly.20261101.1";
const newer = "v0.0.1-nightly.20261102.2";

const gitEnv = {
  PATH: process.env.PATH ?? "",
  HOME: NodeOS.tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

// Pins like nix/update-sources.sh; RACE=once|always pushes to the fork meanwhile.
const updateSources = `#!/usr/bin/env bash
set -euo pipefail
printf '{"version":"%s","x86_64-linux":{}}\\n' "\${1#v}" > nix/sources.json
if [[ "\${RACE:-}" == always || ( "\${RACE:-}" == once && ! -e "$STATE_DIR/raced" ) ]]; then
  touch "$STATE_DIR/raced"
  clone="$(mktemp -d)"
  git clone -q -b self-hosted-nightly "$ORIGIN" "$clone"
  echo r >> "$clone/race.txt"
  git -C "$clone" add race.txt
  git -C "$clone" commit -qm race
  git -C "$clone" push -q origin self-hosted-nightly
fi
`;

type Options = {
  readonly tag?: string;
  readonly forkCommits?: (git: (...args: string[]) => string, write: Write) => void;
  readonly forkOnNewer?: boolean;
  readonly race?: "once" | "always";
  readonly pushUrl?: string;
};
type Write = (file: string, content: string) => void;

function runRebase(options: Options = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rebase-"));
  try {
    const at =
      (cwd: string) =>
      (...args: string[]) =>
        NodeChildProcess.execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
    const writer =
      (cwd: string): Write =>
      (file, content) => {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(cwd, file), content, { mode: 0o755 });
      };

    const up = NodePath.join(root, "up");
    NodeFS.mkdirSync(up);
    const upGit = at(up);
    upGit("init", "-q", "-b", "main");
    for (const [file, tag] of [
      ["a.txt", older],
      ["b.txt", newer],
      ["c.txt", undefined],
    ] as const) {
      writer(up)(file, `${file}\n`);
      upGit("add", file);
      upGit("commit", "-qm", `upstream ${file}`);
      if (tag) upGit("tag", tag);
    }

    const fork = NodePath.join(root, "fork");
    upGit("clone", "-q", up, fork);
    const git = at(fork);
    const write = writer(fork);
    git("checkout", "-q", "-b", "self-hosted-nightly", older);
    write("nix/update-sources.sh", updateSources);
    write("nix/sources.json", '{"version":"unpinned"}\n');
    write("fork.txt", "fork\n");
    git("add", ".");
    git("commit", "-qm", "feat: fork patch");
    write("nix/sources.json", `{"version":"${older.slice(1)}"}\n`);
    git("commit", "-qam", `chore(nix): pin sources for ${older}`);
    write("later.txt", "later\n");
    git("add", ".");
    git("commit", "-qm", "fix: later fork patch");
    options.forkCommits?.(git, write);
    if (options.forkOnNewer) {
      git("rebase", "-q", "--onto", newer, older);
    }
    const origin = NodePath.join(root, "origin.git");
    git("clone", "-q", "--bare", ".", origin);

    const work = NodePath.join(root, "work");
    git("clone", "-q", "-b", "self-hosted-nightly", origin, work);
    const stateDir = NodePath.join(root, "state");
    const run = NodeChildProcess.spawnSync("bash", [script], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...gitEnv,
        TAG: options.tag ?? newer,
        UPSTREAM_URL: up,
        PUSH_URL: options.pushUrl ?? origin,
        STATE_DIR: stateDir,
        ORIGIN: origin,
        RACE: options.race ?? "",
      },
    });
    const read = (name: string) =>
      NodeFS.existsSync(NodePath.join(stateDir, name))
        ? NodeFS.readFileSync(NodePath.join(stateDir, name), "utf8")
        : "";
    return {
      status: run.status,
      state: /^state=(\S+)/m.exec(run.stdout)?.[1] ?? null,
      stage: read("stage"),
      origin: at(origin)("log", "--format=%s", "self-hosted-nightly").split("\n"),
      sources: at(origin)("show", "self-hosted-nightly:nix/sources.json"),
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

it("rebases onto a newer release, drops the old pin and pins the new one", () => {
  const result = runRebase();
  expect(result).toMatchObject({ status: 0, state: "PUSHED" });
  expect(result.origin).toEqual([
    `chore(nix): pin sources for ${newer}`,
    "fix: later fork patch",
    "feat: fork patch",
    "upstream b.txt",
    "upstream a.txt",
  ]);
});

it.each([
  ["NOOP(current)", { tag: older }],
  ["NOOP(older)", { tag: older, forkOnNewer: true }],
] as const)("stops at %s without pushing", (state, options) => {
  const result = runRebase(options);
  expect(result).toMatchObject({ status: 0, state });
  expect(result.origin).not.toContain(`chore(nix): pin sources for ${newer}`);
});

it("takes the fork's nix/sources.json when that is the only conflict", () => {
  const result = runRebase({
    forkCommits: (git, write) => {
      write("nix/sources.json", `{"version":"${older.slice(1)}","x86_64-linux":{}}\n`);
      git("commit", "-qam", "feat(nix): key hashes by system");
    },
  });
  expect(result).toMatchObject({ status: 0, state: "PUSHED" });
  expect(result.origin.slice(0, 2)).toEqual([
    `chore(nix): pin sources for ${newer}`,
    "feat(nix): key hashes by system",
  ]);
  expect(JSON.parse(result.sources)).toEqual({ version: newer.slice(1), "x86_64-linux": {} });
});

it("fails at rebase on any other conflict, pushing nothing", () => {
  const result = runRebase({
    forkCommits: (git, write) => {
      write("b.txt", "conflicts with upstream\n");
      git("add", "b.txt");
      git("commit", "-qm", "fix: conflicts");
    },
  });
  expect(result).toMatchObject({ status: 1, state: null, stage: "rebase" });
  expect(result.origin[0]).toBe("fix: conflicts");
});

it("starts over once when the lease is rejected", () => {
  const result = runRebase({ race: "once" });
  expect(result).toMatchObject({ status: 0, state: "PUSHED" });
  expect(result.origin.slice(0, 2)).toEqual([`chore(nix): pin sources for ${newer}`, "race"]);
});

it("fails as push-race when the lease is rejected twice", () => {
  const result = runRebase({ race: "always" });
  expect(result).toMatchObject({ status: 1, stage: "push-race" });
});

it.each([
  ["resolve", 128, { tag: "v9.9.9-nightly.20991231.1" }],
  ["push", 1, { pushUrl: "/nonexistent/repository.git" }],
] as const)("names %s as the stage when git fails there", (stage, status, options) => {
  expect(runRebase(options)).toMatchObject({ status, stage });
});
