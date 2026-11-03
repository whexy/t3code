// @effect-diagnostics nodeBuiltinImport:off - a build step run by vite.config.ts and the dev server, outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const ENTRY = NodeURL.fileURLToPath(new URL("admin.css", import.meta.url));

/** Builds the admin page's stylesheet: Tailwind and Frost, holding only the classes the page uses. */
export async function compileAdminCss() {
  const compiler = await compile(await NodeFSP.readFile(ENTRY, "utf8"), {
    base: import.meta.dirname,
    from: ENTRY,
    onDependency: () => {},
  });
  const candidates = new Scanner({ sources: compiler.sources }).scan();
  return optimize(compiler.build(candidates), { file: ENTRY, minify: true }).code;
}
