import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { runtime } from "../../lib/runtime";
import { MobileSecureStorage } from "../../persistence/mobile-secure-storage";

const STORAGE_KEY = "t3code.super-thread-panel-seen.v1";
// Only recent super threads still have news worth marking, and secure-store values stay small.
const KEPT_LOOKS = 15;

type Looks = Readonly<Record<string, string>>;

const readStored = () =>
  runtime
    .runPromise(MobileSecureStorage.pipe(Effect.flatMap((storage) => storage.getItem(STORAGE_KEY))))
    .then((raw): Looks => {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed !== null && typeof parsed === "object"
        ? Object.fromEntries(
            Object.entries(parsed).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
    });

// Reads and writes chain on one promise, so a look is read after the previous one is recorded.
let looks: Promise<Looks> | null = null;
const loadLooks = () => (looks ??= readStored().catch((): Looks => ({})));

function markLooked(threadKey: string) {
  looks = loadLooks().then((current) => {
    const { [threadKey]: _previous, ...rest } = current;
    const kept = Object.entries(rest)
      .sort(([, left], [, right]) => right.localeCompare(left))
      .slice(0, KEPT_LOOKS - 1);
    const next: Looks = Object.fromEntries([[threadKey, new Date().toISOString()], ...kept]);
    void runtime
      .runPromise(
        MobileSecureStorage.pipe(
          Effect.flatMap((storage) => storage.setItem(STORAGE_KEY, JSON.stringify(next))),
        ),
      )
      .catch(() => undefined);
    return next;
  });
}

/**
 * When this device last showed the super thread's panel before the current showing; `null` for
 * a first look. The conversation moves the thread's own visit mark, so the panel keeps its own,
 * as on the web. Showing the panel counts as looking until it is hidden.
 */
export function useSuperThreadPanelLook(
  threadKey: string | null,
  visible: boolean,
): string | null | undefined {
  const [look, setLook] = useState<{ readonly key: string; readonly before: string | null }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the look in device storage while the panel is on screen
  useEffect(() => {
    if (!visible || threadKey === null) return;
    let shown = true;
    void loadLooks().then((current) => {
      if (!shown) return;
      setLook({ key: threadKey, before: current[threadKey] ?? null });
      markLooked(threadKey);
    });
    return () => {
      shown = false;
      setLook(undefined);
      markLooked(threadKey);
    };
  }, [threadKey, visible]);
  return look?.key === threadKey ? look.before : undefined;
}
