// @effect-diagnostics nodeBuiltinImport:off - The release job runs this with plain Node and no install, so effect is unavailable.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const USER_FACING = /^(feat|fix|perf)(?:\(([^)]*)\))?!?:\s*(.+)$/;
// Mobile ships through TestFlight, and CI never reaches the app.
const HIDDEN_SCOPES = new Set(["mobile", "ios", "android", "ci"]);
// apps/desktop/src/updates/releaseNotes.ts reads only the text above this block as highlights.
const FULL_CHANGELOG = /<details>\s*<summary>\s*Full changelog\s*<\/summary>/i;

export function forkHighlights(subjects: ReadonlyArray<string>): ReadonlyArray<string> {
  return subjects.flatMap((subject) => {
    const match = USER_FACING.exec(subject.trim());
    if (!match) return [];
    const [, , scope, description = ""] = match;
    if (scope?.split(",").some((part) => HIDDEN_SCOPES.has(part.trim()))) return [];
    return [`- **Fork.** ${description.charAt(0).toUpperCase()}${description.slice(1)}`];
  });
}

// The fork is rebased onto each nightly, so commits are matched across releases by subject.
export function desktopReleaseNotes(
  upstreamBody: string,
  forkSubjects: ReadonlyArray<string>,
  previousForkSubjects: ReadonlyArray<string>,
): string {
  const shipped = new Set(previousForkSubjects.map((subject) => subject.trim()));
  const highlights = forkHighlights(forkSubjects.filter((subject) => !shipped.has(subject.trim())));
  const upstream = upstreamBody.trim();
  if (highlights.length === 0) return `${upstream}\n`;
  const fork = `### In this fork\n\n${highlights.join("\n")}\n`;
  const changelog = upstream.search(FULL_CHANGELOG);
  if (changelog < 0) return `${fork}\n${upstream}\n`;
  return `${upstream.slice(0, changelog).trimEnd()}\n\n${fork}\n${upstream.slice(changelog)}\n`;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const [upstreamBodyPath, forkSubjectsPath, previousForkSubjectsPath] = process.argv.slice(2);
  if (!upstreamBodyPath || !forkSubjectsPath || !previousForkSubjectsPath) {
    throw new Error(
      "Usage: desktop-release-notes.ts <upstream-body> <fork-subjects> <previous-fork-subjects>",
    );
  }
  const lines = (path: string) => NodeFS.readFileSync(path, "utf8").split("\n").filter(Boolean);
  process.stdout.write(
    desktopReleaseNotes(
      NodeFS.readFileSync(upstreamBodyPath, "utf8"),
      lines(forkSubjectsPath),
      lines(previousForkSubjectsPath),
    ),
  );
}
