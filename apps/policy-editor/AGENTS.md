# Policy editor

These rules add to the repository's `AGENTS.md` for work under `apps/policy-editor`. The editor
is a fork-only app: keep its changes inside this directory so the daily rebase onto upstream does
not conflict.

## Frost and the borrowed web controls

Frost owns the editor's look. The inputs, selects, switches, number fields, toggles and buttons
come from `apps/web/src/components/ui` through the `~` alias, and `src/styles/web-controls.css`
points the web roles they use (primary, border, ring, destructive, ...) at Frost tokens. Never edit
`apps/web` to change how the editor looks.

- Write Frost tokens and classes in editor code, never the web roles (`text-ink-muted`, not
  `text-muted-foreground`). The roles exist only for the borrowed controls.
- When a web control clashes with Frost in a way the bridge cannot fix with an existing token,
  replace it with an editor component in `src/ui/` built on the same `@base-ui/react` primitive,
  as `src/ui/dialog.tsx` does for the dialog.
- Frost has no disabled state for its buttons, so actions use the web `Button`, whose disabled
  look the editor needs while a load or save is in flight.

## Design rules (Frost)

This project uses Frost, the design language of www.whexy.com. Values
live in `src/styles/frost/tokens.css`; components and blocks are described
by the `frost` skill. For UI work, use the `frost-page`,
`frost-component` and `frost-review` skills.

- Take every color, radius, shadow and font from `tokens.css`, and never write a hex code, px value or arbitrary `[...]` class outside it. A stray value is how a design drifts one screen at a time.
- Write semantic tokens (`text-ink-muted`, `bg-canvas`, `outline-accent`), not primitives (`text-neutral-500`). Names that say what a value is for survive a palette change.
- Use only the `neutral` grays. Warm or cool grays fight the colored glow behind the glass.
- Reach for a Frost class (`glass-card`, `panel`, `paper`, `btn-glass`, `segmented`, …) before writing utilities, and promote a pattern into `components.css` once it repeats three times. One definition keeps every instance identical.
- Put long-form text on `paper`, never on glass. Blurred, tinted backgrounds cost legibility over many paragraphs.
- Use `accent` (the dusty rose) only for link highlighting, focus rings and text selection. A single functional color stays meaningful only if it is never decoration.
- Keep color decorative and behind glass: tints and blobs at low opacity, `-z-10`, with content in `relative z-10`. Text and controls stay neutral so the page reads calm.
- Give depth with light, not lines: hairline `black/5` borders and `shadow-sm shadow-black/5`, never heavy borders or dark shadows. Heavy edges break the frosted look.
- Keep all content in the single `max-w-content` (720px) column. One column is the site's reading rhythm.
- Make page-level surfaces square and edge to edge below `sm`, and step the radius down when nesting (3xl > 2xl > xl > lg). Phone screens are too narrow to spend on gutters, and nested equal radii look misaligned.
- Use `text-sm` as the UI size, `font-title` (Lato) for headings and controls, and `font-article` (Fira Sans) for reading text. Two families with fixed jobs keep chrome and content distinct.
- Animate with `duration-150` for color and `duration-200` for everything else, and never lift past `scale-[1.02]`. Calm motion is part of the look.
- Give every new interactive element the accent focus ring (`focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`). Keyboard users need to see where they are.
- Use no green, amber or red to signal status; show unavailable data in neutral tones inside the usual component shape. The system has no status colors yet, and color used loosely stops meaning anything.
- Build only states and variants that exist in the component reference. An agent that sees a documented-but-unbuilt variant will keep reaching for it.
- When a decision is listed in the open questions (dark mode, status colors, a new block, …), ask the user before choosing. Reasonable guesses quietly become the design.
