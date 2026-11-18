import { AuthOrchestrationOperateScope, EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render as renderUi } from "../../test/render";
import { OPEN_FROM_DESKTOP, type RexEntry } from "./rexEntry.logic";

const state = vi.hoisted(() => ({
  entry: { kind: "enabled" } as RexEntry,
  openRex: vi.fn(),
  runEditor: vi.fn(),
}));

vi.mock(import("../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: ((_: string, scope: string) =>
    scope === AuthOrchestrationOperateScope) as never,
  useEnvironmentScope: ((_: string, scope: string) =>
    scope === AuthOrchestrationOperateScope) as never,
}));
vi.mock(import("../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.runEditor) as never,
}));
vi.mock(import("../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: (() => ({ label: "mudd" })) as never,
}));
vi.mock(import("../remoteOpen"), async (importOriginal) => ({
  ...(await importOriginal()),
  useRemoteOpenState: () => ({ mode: "local-exec" }) as const,
}));
// Rex's availability and the open itself are stubbed; the choice is the real stored preference.
vi.mock(import("./useRexOpenIn"), async () => {
  const { useRexPreferred } = await import("./rexPreference");
  return {
    useRexOpenIn: () => {
      const [preferred, setPreferred] = useRexPreferred();
      return { entry: state.entry, preferred, setPreferred, open: state.openRex };
    },
  };
});

import { OpenInPicker } from "../components/chat/OpenInPicker";
import { registerOpenFavoriteEditorCommand } from "../components/chat/OpenInPickerShortcut";

const environmentId = EnvironmentId.make("mudd");

async function setup({ entry = { kind: "enabled" } as RexEntry, rexChosen = false } = {}) {
  state.entry = entry;
  state.openRex.mockReset().mockResolvedValue(true);
  state.runEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  window.localStorage.clear();
  if (rexChosen) window.localStorage.setItem("t3code:open-in-rex-preferred", "true");

  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel"));
  stack.use({ [Symbol.dispose]: () => window.localStorage.clear() });
  // The app registers this command at startup (appInit).
  stack.use({ [Symbol.dispose]: registerOpenFavoriteEditorCommand() });
  const screen = stack.use(await renderUi(null));

  const renderPicker = () =>
    act(async () => {
      await screen.rerender(
        <OpenInPicker
          environmentId={environmentId}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          availableEditors={["vscode"]}
          openInCwd="/work/project"
          displayMode="panel"
        />,
      );
    });
  const primaryLabel = () => document.querySelector('[aria-label^="Open in"]')?.textContent;
  const item = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
      element.textContent?.startsWith(label),
    );
  const choose = async (label: string) => {
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Choose editor"]')!.click(),
    );
    await vi.waitFor(() => expect(item(label)).toBeDefined());
    await act(async () => item(label)!.click());
  };
  const pressOpenFavorite = () =>
    act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "o", metaKey: true, bubbles: true, cancelable: true }),
      );
    });

  const environment = stack.move();
  return {
    renderPicker,
    primaryLabel,
    item,
    choose,
    pressOpenFavorite,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

describe("Rex as the preferred target", () => {
  it("choosing Rex makes it the primary and ⌘O opens it; choosing an editor takes it back", async () => {
    await using fixture = await setup();
    const { renderPicker, primaryLabel, item, choose, pressOpenFavorite } = fixture;
    await renderPicker();
    expect(primaryLabel()).toBe("Open in VS Code");

    await choose("Rex");
    expect(state.openRex).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(primaryLabel()).toBe("Open in Rex"));
    expect(window.localStorage.getItem("t3code:open-in-rex-preferred")).toBe("true");

    await pressOpenFavorite();
    expect(state.openRex).toHaveBeenCalledTimes(1);
    expect(state.runEditor).not.toHaveBeenCalled();

    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Choose editor"]')!.click(),
    );
    // The shortcut mark follows the primary.
    await vi.waitFor(() => expect(item("Rex")?.textContent).toBe("Rex⌘O"));
    expect(item("VS Code")?.textContent).toBe("VS Code");
    await act(async () => item("VS Code")!.click());
    await vi.waitFor(() => expect(primaryLabel()).toBe("Open in VS Code"));
    await pressOpenFavorite();
    expect(state.runEditor).toHaveBeenCalledTimes(1);
    expect(state.openRex).toHaveBeenCalledTimes(1);
  });

  it("a Rex choice falls back to the preferred editor where Rex can't open", async () => {
    await using fixture = await setup({
      entry: { kind: "disabled", reason: OPEN_FROM_DESKTOP },
      rexChosen: true,
    });
    const { renderPicker, primaryLabel, pressOpenFavorite } = fixture;
    await renderPicker();
    expect(primaryLabel()).toBe("Open in VS Code");
    await pressOpenFavorite();
    expect(state.runEditor).toHaveBeenCalledTimes(1);
    expect(state.openRex).not.toHaveBeenCalled();
    // The choice is kept for an environment where Rex works.
    expect(window.localStorage.getItem("t3code:open-in-rex-preferred")).toBe("true");
  });
});
