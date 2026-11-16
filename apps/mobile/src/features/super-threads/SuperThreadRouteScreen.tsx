import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  SUPER_THREAD_BOARD_COLUMNS,
  groupSuperThreadBoardItems,
} from "@t3tools/client-runtime/state/super-thread-presentation";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ScopedThreadRef,
  type SuperThreadBoard,
  type SuperThreadMember,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { ListSection } from "../../components/ui/ListSection";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { environmentThreadDetails } from "../../state/threads";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { ChildApproval } from "../threads/ChildThreadApprovals";
import { threadVisitTracker } from "../threads/ThreadDetailScreen";
import { SuperThreadStatus } from "./SuperThreadStatus";

type SuperThreadRouteParams = {
  readonly environmentId: string;
  readonly threadId: string;
};

export function SuperThreadRouteScreen({ route }: StaticScreenProps<SuperThreadRouteParams>) {
  const threadRef = scopeThreadRef(
    EnvironmentId.make(route.params.environmentId),
    ThreadId.make(route.params.threadId),
  );
  return (
    <SuperThreadScreen
      key={scopedThreadKey(threadRef.environmentId, threadRef.threadId)}
      threadRef={threadRef}
    />
  );
}

function useOpenThread() {
  const navigation = useNavigation();
  // Drilling in, so Back returns to the super page.
  return (ref: SuperThreadMember) =>
    navigation.dispatch(
      StackActions.push("Thread", { environmentId: ref.environmentId, threadId: ref.threadId }),
    );
}

/** The super thread's own page: goal, board, open requests, members and a prompt box. */
function SuperThreadScreen(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const goBack = useWorkspaceBackNavigation();
  const openThread = useOpenThread();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const shell = useThreadShell(threadRef);
  const detail = useQuietThreadStructure(threadRef);
  // The page stands in for the transcript, so seeing it clears the header's Done.
  useAtomMount(threadVisitTracker(threadRef));
  const [composerHeight, setComposerHeight] = useState(64);
  const superThread = detail?.projection.thread.superThread;
  const members = superThread?.members ?? shell?.source.superThread?.members ?? [];
  const board = superThread?.board ?? null;
  const isSuper = shell?.source.superThread !== undefined;
  const bottomInset = keyboardVisible ? 8 : Math.max(insets.bottom, 12);

  return (
    <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1 bg-screen">
      <AppBar
        title={shell?.title ?? "Super thread"}
        subtitle="Super thread"
        onBackToList={goBack}
        actions={[
          {
            accessibilityLabel: "Open transcript",
            icon: "text.bubble",
            onPress: () =>
              openThread({ environmentId: threadRef.environmentId, threadId: threadRef.threadId }),
          },
        ]}
      />
      {shell === null || !isSuper ? (
        <View className="flex-1 items-center justify-center">
          <EmptyState
            variant="plain"
            title={shell === null ? "Loading super thread" : "Not a super thread"}
            detail={
              shell === null
                ? "If this takes long, its environment may be offline."
                : "Open its transcript to continue the conversation."
            }
          />
        </View>
      ) : (
        <>
          <ScrollViewMarker style={{ flex: 1 }}>
            <ScrollView
              className="flex-1"
              contentInsetAdjustmentBehavior="automatic"
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              contentContainerStyle={{
                gap: 20,
                padding: 16,
                paddingBottom: composerHeight + bottomInset + 24,
              }}
            >
              <View className="gap-1 px-2">
                <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
                  Goal
                </Text>
                {board !== null && board.goal.trim().length > 0 ? (
                  <Text selectable className="text-base text-foreground">
                    {board.goal}
                  </Text>
                ) : (
                  <Text className="text-sm text-foreground-muted">
                    {detail === null
                      ? "Loading the board…"
                      : "No goal yet. The agent writes it once it has a plan."}
                  </Text>
                )}
              </View>
              <SuperThreadPendingRequests
                threadRef={threadRef}
                title={shell.title}
                onAnswer={() =>
                  openThread({
                    environmentId: threadRef.environmentId,
                    threadId: threadRef.threadId,
                  })
                }
              />
              {board !== null ? <SuperThreadBoardGroups board={board} onOpen={openThread} /> : null}
              <SuperThreadMembers members={members} onOpen={openThread} />
            </ScrollView>
          </ScrollViewMarker>
          <SuperThreadPromptBox
            thread={shell}
            bottomInset={bottomInset}
            onHeightChange={setComposerHeight}
          />
        </>
      )}
    </KeyboardAvoidingView>
  );
}

function SuperThreadPendingRequests(props: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly onAnswer: () => void;
}) {
  const pending = useAtomValue(environmentThreadDetails.pendingRequestsAtom(props.threadRef));
  const approvals = pending?.approvals ?? [];
  const userInputs = pending?.userInputs ?? [];
  if (approvals.length === 0 && userInputs.length === 0) return null;
  return (
    <View className="-mx-3.5 gap-1">
      <Text textRole="footnote" className="mx-5.5 font-t3-medium text-foreground-muted">
        Waiting for you
      </Text>
      {approvals.map((approval) => (
        <ChildApproval
          key={approval.requestId}
          entry={{ thread: props.threadRef, title: props.title, approval }}
        />
      ))}
      {userInputs.map((input) => (
        // Answering needs the composer's multi-step answer flow, so questions open the transcript.
        <View key={input.requestId} className="mx-3.5 my-2 gap-2 rounded-2xl bg-grouped-card p-4">
          {input.questions.map((question) => (
            <View key={question.id} className="gap-0.5">
              <Text className="text-sm font-t3-bold text-foreground">{question.question}</Text>
              {question.options.length > 0 ? (
                <Text className="text-xs text-foreground-muted">
                  {question.options.map((option) => option.label).join(" · ")}
                </Text>
              ) : null}
            </View>
          ))}
          <View className="self-start">
            <Button size="compact" label="Answer in the transcript" onPress={props.onAnswer} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** The agent's board as a phone-width list, one group per status that has items. */
function SuperThreadBoardGroups(props: {
  readonly board: SuperThreadBoard;
  readonly onOpen: (member: SuperThreadMember) => void;
}) {
  const shells = useThreadShells();
  if (props.board.items.length === 0) {
    return (
      <Text className="px-2 text-sm text-foreground-muted">
        The agent has not added any work items yet.
      </Text>
    );
  }
  const titleByKey = new Map(
    shells.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell.title]),
  );
  const groups = groupSuperThreadBoardItems(props.board.items);
  return SUPER_THREAD_BOARD_COLUMNS.filter(({ status }) => groups[status].length > 0).map(
    ({ status, label }) => (
      <ListSection key={status} title={`${label} (${groups[status].length})`}>
        {groups[status].map((item, index) => (
          <View
            key={item.id}
            className={index > 0 ? "gap-1 border-t border-border-subtle p-4" : "gap-1 p-4"}
          >
            <Text className="text-base font-t3-medium text-foreground">{item.title}</Text>
            {item.note ? (
              <Text selectable className="text-sm text-foreground-muted">
                {item.note}
              </Text>
            ) : null}
            {item.members?.map((member) => {
              const key = scopedThreadKey(member.environmentId, member.threadId);
              return (
                <Pressable
                  key={key}
                  accessibilityRole="link"
                  onPress={() => props.onOpen(member)}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <Text className="text-sm text-primary" numberOfLines={1}>
                    {titleByKey.get(key) ?? "Open thread"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </ListSection>
    ),
  );
}

/** Every member this client holds, settled ones included; the list shows only unsettled ones. */
function SuperThreadMembers(props: {
  readonly members: ReadonlyArray<SuperThreadMember>;
  readonly onOpen: (member: SuperThreadMember) => void;
}) {
  const shells = useThreadShells();
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  if (props.members.length === 0) {
    return (
      <ListSection title="Threads">
        <Text className="p-4 text-sm text-foreground-muted">
          Threads the agent launches show up here and in the thread list.
        </Text>
      </ListSection>
    );
  }
  const shellByKey = new Map(
    shells.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell]),
  );
  const projectTitleByKey = new Map(
    projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project.title]),
  );
  const held = props.members.flatMap((member): EnvironmentThreadShell[] => {
    const shell = shellByKey.get(scopedThreadKey(member.environmentId, member.threadId));
    return shell === undefined || shell.deletedAt !== null ? [] : [shell];
  });
  const missing = props.members.length - held.length;
  return (
    <ListSection
      title="Threads"
      footer={
        missing > 0
          ? `${missing} more on environments this device can't reach right now.`
          : undefined
      }
    >
      {held.map((shell, index) => {
        const hint = [
          projectTitleByKey.get(scopedProjectKey(shell.environmentId, shell.projectId)),
          savedConnectionsById[shell.environmentId]?.environmentLabel,
        ]
          .filter((part): part is string => !!part)
          .join(" · ");
        return (
          <Pressable
            key={scopedThreadKey(shell.environmentId, shell.id)}
            accessibilityRole="button"
            accessibilityLabel={hint ? `${shell.title}, ${hint}` : shell.title}
            onPress={() => props.onOpen({ environmentId: shell.environmentId, threadId: shell.id })}
            className={
              index > 0
                ? "flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
                : "flex-row items-center gap-3 px-4 py-3"
            }
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <View className="min-w-0 flex-1">
              <Text className="text-base text-foreground" numberOfLines={1}>
                {shell.title}
              </Text>
              {hint ? (
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {hint}
                </Text>
              ) : null}
            </View>
            <SuperThreadStatus thread={shell} />
          </Pressable>
        );
      })}
    </ListSection>
  );
}

/** Sends through the outbox like the thread composer, with the super thread's own settings. */
function SuperThreadPromptBox(props: {
  readonly thread: EnvironmentThreadShell;
  readonly bottomInset: number;
  readonly onHeightChange: (height: number) => void;
}) {
  const { thread } = props;
  const canSend = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();

  const send = async () => {
    if (trimmed.length === 0 || sending || !canSend) return;
    setSending(true);
    setError(null);
    const queued = await enqueueThreadOutboxMessage({
      environmentId: thread.environmentId,
      threadId: thread.id,
      messageId: MessageId.make(uuidv4()),
      commandId: CommandId.make(uuidv4()),
      text: trimmed,
      attachments: [],
      dispatchMode: "auto",
      createdAt: new Date().toISOString(),
    }).then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause.message : "Could not send the message."),
    );
    setSending(false);
    if (queued === null) setText("");
    else setError(queued);
  };

  return (
    <View
      className="absolute inset-x-4 bottom-0 gap-2"
      style={{ paddingBottom: props.bottomInset }}
      onLayout={(event) => props.onHeightChange(event.nativeEvent.layout.height)}
    >
      {error !== null ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <GlassSurface chrome="none" className="flex-row items-end gap-1 p-1">
        <TextInput
          accessibilityLabel="Message the super thread"
          multiline
          maxLength={65536}
          placeholder={
            canSend ? "Steer the work or ask for an update" : "You can't send to this thread"
          }
          placeholderTextColorClassName="accent-foreground-muted"
          value={text}
          onChangeText={setText}
          editable={canSend && !sending}
          className="max-h-36 min-h-12 min-w-0 flex-1 rounded-[24px] border-0 bg-transparent px-4 py-3 text-base text-foreground"
        />
        <View>
          <Button
            label="Send"
            tone="contrast"
            loading={sending}
            disabled={!canSend || sending || trimmed.length === 0}
            onPress={() => void send()}
          />
        </View>
      </GlassSurface>
    </View>
  );
}
