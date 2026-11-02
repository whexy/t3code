// @effect-diagnostics nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite-plus";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.resolve(here, "../..");
const shim = (name: string) => NodePath.join(here, "src/shims", name);

/**
 * The editor runs the server's own policy validation and the web app's own controls. Two modules
 * they import cannot come along: the web app's `lib/utils` pulls in the whole app, and the server's
 * source control registry sits beside its Node-only drivers. Each shim exports the same values.
 */
const REDIRECTS: ReadonlyMap<string, string> = new Map([
  [NodePath.join(repo, "apps/web/src/lib/utils.ts"), shim("cn.ts")],
  [
    NodePath.join(repo, "apps/server/src/sourceControl/sourceControlDefinitions.ts"),
    shim("sourceControlDefinitions.ts"),
  ],
]);

function redirectModules(): Plugin {
  return {
    name: "policy-editor:redirect-modules",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (
        importer === undefined ||
        !/(?:^|\/)(?:utils|sourceControlDefinitions)(?:\.ts)?$/.test(source)
      ) {
        return null;
      }
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved === null ? null : (REDIRECTS.get(resolved.id) ?? null);
    },
  };
}

export default defineConfig({
  root: here,
  // Relative asset URLs, so the build works from any path.
  base: "./",
  plugins: [redirectModules(), tailwindcss(), react()],
  resolve: { alias: { "~": NodePath.join(repo, "apps/web/src") } },
  server: { port: 5790, strictPort: false },
  // One page whose validation needs Effect and the settings schemas; splitting it gains nothing.
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 1200 },
});
