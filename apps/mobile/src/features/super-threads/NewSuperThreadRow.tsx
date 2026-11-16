import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { cn } from "../../lib/cn";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { createNewTaskDraft, waitForComposerDraftsLoaded } from "../../state/use-composer-drafts";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { markSuperThreadDraft } from "./superThreadCreations";

const TITLE = "New super thread";
const SUBTITLE = "Coordinate threads across projects";

/**
 * Opens a No project draft that becomes a super thread when sent, as web does. `option` is the
 * environment the No project row would use.
 */
export function NewSuperThreadRow(props: {
  readonly option: { readonly environmentId: EnvironmentId; readonly ready: boolean } | null;
}) {
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const selectDetail = useSelectWorkspaceDetail();
  const inFlight = useRef(false);
  if (props.option === null) return null;
  const { environmentId, ready } = props.option;

  const fail = (error: unknown) =>
    Dialog.alert(
      "Could not start a super thread",
      error instanceof Error
        ? error.message
        : "The folder for threads without a project could not be created.",
    );
  const openDraft = async () => {
    const scratch = await openScratch({ environmentId, input: {} });
    if (scratch._tag === "Failure") {
      if (!isAtomCommandInterrupted(scratch)) fail(squashAtomCommandFailure(scratch));
      return;
    }
    await waitForComposerDraftsLoaded();
    const draftId = createNewTaskDraft({ environmentId, projectId: scratch.value.id });
    await markSuperThreadDraft(draftId);
    selectDetail({
      name: "Thread",
      params: { draft: { environmentId, projectId: scratch.value.id, title: TITLE, draftId } },
    });
  };
  const start = async () => {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    await openDraft().catch(fail);
    inFlight.current = false;
  };
  const icon = (size: number) => (
    <SymbolView
      name="point.3.connected.trianglepath.dotted"
      size={size}
      tintColorClassName="accent-icon-muted"
      type="monochrome"
    />
  );

  if (Platform.OS === "android") {
    return (
      <View collapsable={false} className="overflow-hidden rounded-[28px] bg-grouped-card">
        <NavigationRow
          className="bg-grouped-card"
          title={TITLE}
          subtitle={SUBTITLE}
          disabled={!ready}
          onPress={() => void start()}
          leading={icon(22)}
        />
      </View>
    );
  }
  return (
    <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={TITLE}
        accessibilityHint={SUBTITLE}
        disabled={!ready}
        onPress={() => void start()}
        className={cn(
          "flex-row items-center gap-3 bg-grouped-card px-4 py-3.5",
          !ready && "opacity-45",
        )}
      >
        <View className="h-7 w-7 items-center justify-center">{icon(18)}</View>
        <View className="min-w-0 flex-1">
          <Text className="text-base font-t3-bold leading-snug">{TITLE}</Text>
          <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
            {SUBTITLE}
          </Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
