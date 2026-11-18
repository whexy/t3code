import { MenuItem, MenuItemLabel, MenuShortcut } from "../components/ui/menu";
import { RexIcon } from "./RexIcon";
import type { RexOpenIn } from "./useRexOpenIn";

/** What the picker's primary button shows while Rex leads it. */
export const REX_PRIMARY = { label: "Rex", Icon: RexIcon, kind: "brand" } as const;

/** Rex's row in Open in…: like an editor's, it opens from a menu and is chosen from a picker. */
export function RexOpenInItem({
  rex,
  presentation,
  shortcutLabel,
}: {
  rex: RexOpenIn;
  presentation: "toolbar" | "menu";
  /** Shown while Rex leads the picker, as the preferred editor's row shows it. */
  shortcutLabel: string | null;
}) {
  const { entry } = rex;
  if (entry.kind === "hidden") return null;
  return (
    <MenuItem
      density={presentation === "menu" ? "touch" : "default"}
      disabled={entry.kind === "disabled"}
      onClick={() => {
        if (presentation === "menu") void rex.open();
        else rex.setPreferred(true);
      }}
    >
      <RexIcon aria-hidden="true" />
      <MenuItemLabel>{entry.kind === "disabled" ? `Rex: ${entry.reason}` : "Rex"}</MenuItemLabel>
      {shortcutLabel !== null && <MenuShortcut>{shortcutLabel}</MenuShortcut>}
    </MenuItem>
  );
}
