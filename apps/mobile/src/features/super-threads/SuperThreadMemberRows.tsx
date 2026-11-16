import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { ComponentProps } from "react";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import type { ThreadPrPresentation } from "../../state/thread-pr-presentation";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { useThreadListActions } from "../home/useThreadListActions";
import { ThreadListV2Row } from "../threads/thread-list-v2-items";
import { buildThreadListV2ListItems, resolveThreadListV2WokeAt } from "../threads/threadListV2";
import { useThreadRowProviderInstanceResolver } from "../threads/thread-provider-instance";
import { useThreadListNow } from "../threads/use-thread-list-now";

/** What the list around a section hands its member rows, so they swipe and open like its own rows. */
export interface SuperThreadMemberRowHost {
  readonly fullSwipeWidth: number | undefined;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture: ComponentProps<
    typeof ThreadListV2Row
  >["simultaneousSwipeGesture"];
  readonly onOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
}

/**
 * A section's members as the list's own thread rows, with their swipe actions and menu. Pin,
 * snooze and reordering are off: the section lists every unsettled member in its own order, so
 * those would change nothing on screen.
 */
export function SuperThreadMemberRows(props: {
  readonly rows: ReadonlyArray<EnvironmentThreadShell>;
  readonly hints: ReadonlyMap<string, string>;
  /** The hints name each member's machine, so the row shows the machine's icon beside them. */
  readonly showEnvironment: boolean;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly pane: "screen" | "sidebar";
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly host: SuperThreadMemberRowHost;
}) {
  const actions = useThreadListActions();
  const {
    providersByEnvironmentId,
    machineByEnvironmentId,
    settlementEnvironmentIds,
    autoSettleOptOutEnvironmentIds,
    titleRegenerationEnvironmentIds,
  } = useAtomValue(threadListEnvironmentsAtom);
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId);
  const queuedThreadKeys = useQueuedThreadKeys();
  const now = useThreadListNow(props.rows);
  const items = buildThreadListV2ListItems({
    items: props.rows.map((thread, index) => ({
      thread,
      variant: "card" as const,
      snoozed: false,
      pinned: false,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      isLast: index === props.rows.length - 1,
    })),
    pendingTasks: [],
    queuedThreadKeys,
  });
  const { host } = props;

  return items.map((item) => {
    if (item.type !== "v2-thread") return null;
    const thread = item.item.thread;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    return (
      <ThreadListV2Row
        key={key}
        thread={thread}
        variant="card"
        pane={props.pane}
        selected={props.selectedThreadKey === key}
        hasQueuedMessages={item.hasQueuedMessages}
        wokeAt={item.item.wokeAt}
        snoozePresetMinute=""
        timeLabel={item.timeLabel}
        showTrailingDivider={false}
        project={
          props.projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
        }
        providerInstance={resolveProviderInstance(thread)}
        providers={providersByEnvironmentId.get(thread.environmentId)}
        // The row's second line names where the member works: its project, and its machine when the group spans several.
        environmentLabel={props.hints.get(key) ?? null}
        environmentMachine={
          props.showEnvironment ? machineByEnvironmentId.get(thread.environmentId) : undefined
        }
        fullSwipeWidth={host.fullSwipeWidth}
        onSelectThread={props.onSelectThread}
        onOpenThreadPullRequests={host.onOpenThreadPullRequests}
        onNewThreadOnBranch={host.onNewThreadOnBranch}
        onDeleteThread={actions.confirmDeleteThread}
        onArchiveThread={actions.archiveThread}
        onRenameThread={actions.renameThread}
        onRegenerateThreadTitle={actions.regenerateThreadTitle}
        titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
        settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
        onSettleThread={actions.settleThread}
        snoozeSupported={false}
        snoozePresets={undefined}
        pinningSupported={false}
        autoSettleOptOutSupported={autoSettleOptOutEnvironmentIds.has(thread.environmentId)}
        reorderSupported={false}
        onSnoozeThread={actions.snoozeThread}
        onUnsnoozeThread={actions.unsnoozeThread}
        onUnsettleThread={actions.unsettleThread}
        onPinThread={actions.pinThread}
        onUnpinThread={actions.unpinThread}
        onSetThreadAutoSettle={actions.setThreadAutoSettle}
        onSwipeableClose={host.onSwipeableClose}
        onSwipeableWillOpen={host.onSwipeableWillOpen}
        simultaneousSwipeGesture={host.simultaneousSwipeGesture}
      />
    );
  });
}
