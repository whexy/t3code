/**
 * The admin page's stylesheet, compiled from source when the bridge runs
 * unbundled. `vp pack` replaces this module with the compiled CSS
 * (vite.config.ts), so the bundle never loads Tailwind.
 */
export const adminCss = (): Promise<string> =>
  import("../styles/compile.ts").then((module) => module.compileAdminCss());
