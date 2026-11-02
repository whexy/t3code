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
  // Relative asset URLs, so the build works from any path on any static host.
  base: "./",
  plugins: [redirectModules(), tailwindcss(), react()],
  resolve: {
    alias: { "~": NodePath.join(repo, "apps/web/src") },
    // Borrowed web and server files resolve packages from their own folders, which a filtered
    // install (such as Vercel's) leaves empty; resolve them from this app instead.
    dedupe: [
      "react",
      "react-dom",
      "@base-ui/react",
      "class-variance-authority",
      "lucide-react",
      "tailwind-merge",
      "effect",
      "@t3tools/contracts",
      "@t3tools/provider-acp-registry",
      "@t3tools/provider-core",
      "@t3tools/provider-cursor",
      "@t3tools/provider-fx",
      "@t3tools/provider-grok",
      "@t3tools/provider-muse",
      "@t3tools/provider-opencode",
      "@t3tools/provider-pi",
      "@t3tools/source-control-definitions",
    ],
  },
  server: { port: 5790, strictPort: false },
  // One page whose validation needs Effect and the settings schemas; splitting it gains nothing.
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 1200 },
});
