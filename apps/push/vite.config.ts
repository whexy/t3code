import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    outDir: "dist",
    clean: true,
    // One self-contained file: workspace packages and the relay sources it
    // reuses ship TypeScript, which Node will not type-strip from node_modules.
    deps: { alwaysBundle: () => true, onlyBundle: false },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
