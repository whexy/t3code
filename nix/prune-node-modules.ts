// Keeps only what the server bundle loads from disk: the runtime externals
// build-cli-archive.ts stages, and the packages they reach in pnpm's store.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isRuntimeExternalCliDependency } from "../scripts/lib/cli-external-packages.ts";

const root = NodePath.resolve(process.argv[2] ?? "");
const modules = NodePath.join(root, "node_modules");
const store = NodePath.join(modules, ".pnpm");

const packageDirs = (dir: string): string[] =>
  NodeFS.readdirSync(dir).flatMap((name) => {
    if (name.startsWith(".")) return [];
    const path = NodePath.join(dir, name);
    return name.startsWith("@")
      ? NodeFS.readdirSync(path).map((n) => NodePath.join(path, n))
      : [path];
  });

const kept = new Set<string>();
const visit = (link: string) => {
  const target = NodeFS.realpathSync(link);
  const entry = NodePath.relative(store, target).split(NodePath.sep)[0];
  if (entry === undefined || entry.startsWith("..") || kept.has(entry)) return;
  kept.add(entry);
  for (const dep of packageDirs(NodePath.join(store, entry, "node_modules"))) visit(dep);
};

for (const dir of packageDirs(modules)) {
  const name = NodePath.relative(modules, dir).split(NodePath.sep).join("/");
  if (isRuntimeExternalCliDependency(name)) visit(dir);
  else NodeFS.rmSync(dir, { recursive: true });
}
for (const entry of NodeFS.readdirSync(store)) {
  if (!kept.has(entry) && entry !== "node_modules") {
    NodeFS.rmSync(NodePath.join(store, entry), { recursive: true });
  }
}
for (const dir of [modules, NodePath.join(store, "node_modules")]) {
  if (!NodeFS.existsSync(dir)) continue;
  for (const path of packageDirs(dir)) {
    if (!NodeFS.existsSync(path)) NodeFS.rmSync(path, { recursive: true, force: true });
  }
  for (const name of NodeFS.readdirSync(dir)) {
    const path = NodePath.join(dir, name);
    if (name.startsWith("@") && NodeFS.readdirSync(path).length === 0) NodeFS.rmdirSync(path);
  }
}
