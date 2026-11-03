import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { compileAdminCss } from "./styles/compile.ts";

export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    outDir: "dist",
    clean: true,
    // One self-contained file: workspace packages ship TypeScript source,
    // which Node will not type-strip from node_modules in a container.
    deps: { alwaysBundle: () => true, onlyBundle: false },
    plugins: [
      {
        name: "admin-css",
        async load(id) {
          if (!id.endsWith("/src/adminCss.ts")) return null;
          const css = JSON.stringify(await compileAdminCss());
          return `export const adminCss = () => Promise.resolve(${css});`;
        },
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
  },
});
