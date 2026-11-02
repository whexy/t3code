import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// Same as `cn` in apps/web/src/lib/utils.ts, whose module also imports the rest of the web app.
const twMerge = extendTailwindMerge({
  extend: {
    theme: { text: ["2xs", "3xs", "4xs", "5xs"] },
    classGroups: { "bg-image": [{ bg: ["composer-seam-below", "composer-seam-above"] }] },
  },
});

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
