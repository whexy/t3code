import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

// Kept apart from the preferred editor: Rex opens folders only, and file links still need an editor.
const REX_PREFERRED_KEY = "t3code:open-in-rex-preferred";

/** Whether this device chose Rex in Open in…. */
export function useRexPreferred() {
  return useLocalStorage(REX_PREFERRED_KEY, false, Schema.Boolean);
}
