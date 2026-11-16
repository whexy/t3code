import type { SuperThreadMapLayout } from "@t3tools/client-runtime/state/super-thread-map";
import type { SuperThreadMap as SuperThreadMapState, SuperThreadMember } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { SheetHeader } from "../../components/ui/SheetHeader";
import {
  SUPER_THREAD_MAP_READABLE_ZOOM,
  SuperThreadMapCanvas,
  SuperThreadMapViewport,
  superThreadMapFitZoom,
} from "./SuperThreadMap";
import { SuperThreadNodeDetail } from "./SuperThreadNodeDetail";

/** The map on the whole screen, to pan, pinch and tap through a plan too big for the panel. */
export function SuperThreadMapFullScreen(props: {
  readonly visible: boolean;
  readonly title: string;
  readonly map: SuperThreadMapState;
  readonly layout: SuperThreadMapLayout;
  readonly addedNodeIds: ReadonlySet<string>;
  readonly onClose: () => void;
  /** Runs once the full-screen map has gone, so the thread doesn't open beneath it. */
  readonly onOpenThread: (thread: SuperThreadMember) => void;
}) {
  const pendingThread = useRef<SuperThreadMember | null>(null);
  const openThread = (thread: SuperThreadMember) => {
    // Android's Modal reports no dismissal, and closes without an animation to wait for.
    if (Platform.OS !== "ios") {
      props.onClose();
      props.onOpenThread(thread);
      return;
    }
    pendingThread.current = thread;
    props.onClose();
  };
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
      onDismiss={() => {
        const thread = pendingThread.current;
        pendingThread.current = null;
        if (thread !== null) props.onOpenThread(thread);
      }}
    >
      {/* A Modal is its own native hierarchy, so it measures its own safe area. */}
      <SafeAreaProvider style={{ flex: 1 }}>
        {props.visible ? (
          <FullScreenMap {...props} onOpenThread={openThread} />
        ) : (
          <View className="flex-1 bg-screen" />
        )}
      </SafeAreaProvider>
    </Modal>
  );
}

function FullScreenMap(props: {
  readonly title: string;
  readonly map: SuperThreadMapState;
  readonly layout: SuperThreadMapLayout;
  readonly addedNodeIds: ReadonlySet<string>;
  readonly onClose: () => void;
  readonly onOpenThread: (thread: SuperThreadMember) => void;
}) {
  const { layout } = props;
  const insets = useSafeAreaInsets();
  const [viewport, setViewport] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  // Bumping `generation` remounts the viewport, which is how a new starting zoom applies.
  const [view, setView] = useState({ generation: 0, whole: false });
  const [shownNodeId, setShownNodeId] = useState<string | null>(null);
  const shownNode = props.map.nodes.find((node) => node.id === shownNodeId) ?? null;
  const fit = viewport === null ? 1 : superThreadMapFitZoom(layout, viewport);
  const readable = Math.min(1, Math.max(fit, SUPER_THREAD_MAP_READABLE_ZOOM));
  const fitsAlready = fit >= readable;
  return (
    <View className="flex-1 bg-screen">
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1 }}>
        <SheetHeader
          presentation="inline"
          title={props.title}
          subtitle="Map"
          onClose={props.onClose}
          accessibilityLabel="Close the map"
          actions={
            fitsAlready
              ? []
              : [
                  view.whole
                    ? {
                        accessibilityLabel: "Zoom in to read",
                        icon: "arrow.up.left.and.arrow.down.right",
                        onPress: () => setView({ generation: view.generation + 1, whole: false }),
                      }
                    : {
                        accessibilityLabel: "Show the whole map",
                        icon: "arrow.down.right.and.arrow.up.left",
                        onPress: () => setView({ generation: view.generation + 1, whole: true }),
                      },
                ]
          }
        />
        <View
          accessibilityLabel="Task map"
          className="flex-1 bg-subtle"
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            if (width === 0 || height === 0) return;
            if (viewport?.width === width && viewport.height === height) return;
            setViewport({ width, height });
          }}
        >
          {viewport === null ? null : (
            <SuperThreadMapViewport
              key={`${viewport.width}x${viewport.height}:${view.generation}`}
              layout={layout}
              startZoom={view.whole ? fit : readable}
              minimumZoom={fit}
            >
              <SuperThreadMapCanvas
                layout={layout}
                addedNodeIds={props.addedNodeIds}
                onOpenThread={props.onOpenThread}
                onShowNode={setShownNodeId}
              />
            </SuperThreadMapViewport>
          )}
        </View>
      </SafeAreaView>
      {shownNode !== null ? (
        <View
          className="absolute inset-x-0 bottom-0 max-h-[55%] rounded-t-3xl border-t border-border-subtle bg-sheet-solid"
          style={{ paddingBottom: insets.bottom }}
        >
          <View className="flex-row items-center gap-2 pt-2 pr-2 pl-6">
            <Text className="min-w-0 flex-1 text-lg font-t3-bold text-foreground" numberOfLines={2}>
              {shownNode.title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close details"
              onPress={() => setShownNodeId(null)}
              className="size-11 items-center justify-center"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <SymbolView name="xmark" size={16} tintColorClassName="accent-foreground-muted" />
            </Pressable>
          </View>
          <ScrollView
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ gap: 16, paddingHorizontal: 16, paddingBottom: 16 }}
          >
            <SuperThreadNodeDetail node={shownNode} onOpenThread={props.onOpenThread} />
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
