import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SUPER_THREAD_MAP_NODE_HEIGHT,
  SUPER_THREAD_MAP_NODE_WIDTH,
  SUPER_THREAD_MAP_STATE_LABELS,
  resolveSuperThreadMapNodeState,
  type SuperThreadMapLayout,
  type SuperThreadMapLayoutNode,
  type SuperThreadMapNodeState,
} from "@t3tools/client-runtime/state/super-thread-map";
import type {
  EnvironmentId,
  SuperThreadMap as SuperThreadMapState,
  SuperThreadMember,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { memo, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Svg, { Defs, Marker, Path } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { environmentThreadShells } from "../../state/threads";

export const STATE_PRESENTATION: Record<
  SuperThreadMapNodeState,
  {
    readonly icon: AppSymbolName;
    readonly className: string;
    readonly tint: string;
  }
> = {
  "needs-you": {
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    tint: "accent-adaptive-indigo-600-300",
  },
  failed: {
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    tint: "accent-danger-foreground",
  },
  dropped: {
    icon: "slash.circle",
    className: "text-foreground-muted",
    tint: "accent-foreground-muted",
  },
  working: {
    icon: "circle.dashed",
    className: "text-adaptive-sky-600-400",
    tint: "accent-adaptive-sky-600-400",
  },
  blocked: {
    icon: "exclamationmark.triangle",
    className: "text-warning-foreground",
    tint: "accent-warning-foreground",
  },
  done: {
    icon: "checkmark.circle",
    className: "text-adaptive-emerald-700-300",
    tint: "accent-adaptive-emerald-700-300",
  },
  active: {
    icon: "circle.inset.filled",
    className: "text-adaptive-sky-600-400",
    tint: "accent-adaptive-sky-600-400",
  },
  planned: { icon: "circle", className: "text-foreground-muted", tint: "accent-foreground-muted" },
};

// One atom per node's thread list, so a thread's update repaints only the nodes that link it.
const linkedShellsAtom = Atom.family((key: string) => {
  const refs = (JSON.parse(key) as Array<[EnvironmentId, ThreadId]>).map(([environmentId, id]) =>
    scopeThreadRef(environmentId, id),
  );
  return Atom.make((get) =>
    refs.map((ref) => get(environmentThreadShells.quietThreadShellAtom(ref))),
  );
});

const threadsKey = (threads: ReadonlyArray<SuperThreadMember> | undefined) =>
  JSON.stringify((threads ?? []).map((thread) => [thread.environmentId, thread.threadId]));

/** A node's linked threads as this client holds them; `null` is one it can't reach. */
export function useLinkedShells(threads: ReadonlyArray<SuperThreadMember> | undefined) {
  return useAtomValue(linkedShellsAtom(threadsKey(threads)));
}

// Readable on a phone while still showing more than one column.
export const SUPER_THREAD_MAP_READABLE_ZOOM = 0.8;
const SMALLEST_ZOOM = 0.25;
const LARGEST_ZOOM = 2.5;
const ARROW_ID = "super-thread-map-arrow";

const SuperThreadMapNode = memo(function SuperThreadMapNode(props: {
  readonly placed: SuperThreadMapLayoutNode;
  readonly isNew: boolean;
  readonly onPress: (nodeId: string, only: SuperThreadMember | null) => void;
  readonly onLongPress: (nodeId: string) => void;
}) {
  const { node, x, y } = props.placed;
  const shells = useLinkedShells(node.threads);
  const { state, unreachable } = resolveSuperThreadMapNodeState(node.status, shells);
  const presentation = STATE_PRESENTATION[state];
  const only = node.threads?.length === 1 ? node.threads[0]! : null;
  const threadCount = node.threads?.length ?? 0;
  return (
    <Pressable
      accessibilityRole={only === null ? "button" : "link"}
      accessibilityLabel={`${node.title}, ${SUPER_THREAD_MAP_STATE_LABELS[state]}${
        props.isNew ? ", new since you looked" : ""
      }`}
      accessibilityHint={only === null ? "Shows its details" : "Opens its thread"}
      onPress={() => props.onPress(node.id, only)}
      onLongPress={() => props.onLongPress(node.id)}
      className={cn(
        "absolute justify-center gap-1 rounded-lg border bg-screen px-3",
        state === "needs-you" ? "border-adaptive-indigo-600-300" : "border-border",
        state === "dropped" && "opacity-55",
      )}
      style={({ pressed }) => [
        {
          left: x,
          top: y,
          width: SUPER_THREAD_MAP_NODE_WIDTH,
          height: SUPER_THREAD_MAP_NODE_HEIGHT,
          borderStyle: state === "planned" ? "dashed" : "solid",
          borderWidth: state === "needs-you" ? 1.5 : StyleSheet.hairlineWidth * 2,
        },
        pressed && { opacity: 0.6 },
      ]}
    >
      <View className="flex-row items-center gap-1">
        <SymbolView
          name={presentation.icon}
          size={11}
          tintColorClassName={presentation.tint}
          type="monochrome"
        />
        <Text
          allowFontScaling={false}
          className={cn("text-xs font-t3-medium", presentation.className)}
        >
          {SUPER_THREAD_MAP_STATE_LABELS[state]}
        </Text>
        {threadCount > 1 ? (
          <Text allowFontScaling={false} className="text-xs text-foreground-muted">
            · {threadCount} threads
          </Text>
        ) : null}
        {unreachable ? (
          <SymbolView
            name="wifi.slash"
            size={11}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
        ) : null}
        {props.isNew ? <View className="ml-auto size-1.5 rounded-full bg-primary" /> : null}
      </View>
      <Text
        allowFontScaling={false}
        numberOfLines={2}
        className={cn(
          "text-sm leading-snug font-t3-medium text-foreground",
          state === "dropped" && "line-through",
        )}
      >
        {node.title}
      </Text>
    </Pressable>
  );
});

export function SuperThreadMapCanvas(props: {
  readonly layout: SuperThreadMapLayout;
  readonly addedNodeIds: ReadonlySet<string>;
  readonly onOpenThread: (thread: SuperThreadMember) => void;
  readonly onShowNode: (nodeId: string) => void;
}) {
  const { layout } = props;
  const edgeColor = StyleSheet.flatten(useResolveClassNames("text-foreground-muted"))?.color;
  const onPressNode = (nodeId: string, only: SuperThreadMember | null) =>
    only === null ? props.onShowNode(nodeId) : props.onOpenThread(only);
  return (
    <View style={{ width: layout.width, height: layout.height }}>
      {layout.lanes.map((lane) =>
        lane.group === null ? null : (
          <View
            key={lane.group}
            className="absolute inset-x-2 rounded-lg border border-border-subtle"
            style={{ top: lane.y, height: lane.height }}
          >
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              className="absolute top-1 left-3 text-xs font-t3-medium text-foreground-muted"
            >
              {lane.group}
            </Text>
          </View>
        ),
      )}
      <Svg
        pointerEvents="none"
        width={layout.width}
        height={layout.height}
        style={StyleSheet.absoluteFill}
      >
        <Defs>
          <Marker
            id={ARROW_ID}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <Path d="M0,0 L10,5 L0,10 z" fill={edgeColor} />
          </Marker>
        </Defs>
        {layout.edges.map((edge) => (
          <Path
            key={`${edge.from}\u0000${edge.to}`}
            d={edge.path}
            fill="none"
            stroke={edgeColor}
            strokeOpacity={0.7}
            strokeWidth={1.25}
            {...(edge.kind === "depends"
              ? { markerEnd: `url(#${ARROW_ID})` }
              : { strokeDasharray: "4 4" })}
          />
        ))}
      </Svg>
      {layout.edges.map((edge) =>
        edge.label === undefined ? null : (
          <View
            key={`${edge.from}\u0000${edge.to}`}
            pointerEvents="none"
            className="absolute items-center"
            style={{ left: edge.labelX - 80, top: edge.labelY - 8, width: 160 }}
          >
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              className="rounded bg-screen px-1 text-[11px] leading-4 text-foreground-muted"
            >
              {edge.label}
            </Text>
          </View>
        ),
      )}
      {layout.nodes.map((placed) => (
        <SuperThreadMapNode
          key={placed.node.id}
          placed={placed}
          isNew={props.addedNodeIds.has(placed.node.id)}
          onPress={onPressNode}
          onLongPress={props.onShowNode}
        />
      ))}
    </View>
  );
}

/**
 * Pans both ways and, on iOS, pinches to zoom. Android has no native zoom, so it pans at full
 * size. Remount it to apply a new `startZoom`; a plan change alone keeps the user's zoom.
 */
export function SuperThreadMapViewport(props: {
  readonly layout: SuperThreadMapLayout;
  readonly startZoom: number;
  readonly minimumZoom: number;
  readonly children: ReactNode;
}) {
  // A zoom given on mount is clamped by the default minimum of 1, so it is applied after layout.
  const [laidOut, setLaidOut] = useState(false);
  if (Platform.OS !== "ios") {
    return (
      <ScrollView className="flex-1" nestedScrollEnabled>
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
          {props.children}
        </ScrollView>
      </ScrollView>
    );
  }
  return (
    <ScrollView
      className="flex-1"
      onLayout={() => setLaidOut(true)}
      contentContainerStyle={{ width: props.layout.width, height: props.layout.height }}
      minimumZoomScale={props.minimumZoom}
      maximumZoomScale={LARGEST_ZOOM}
      zoomScale={laidOut ? props.startZoom : 1}
      bouncesZoom
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      {props.children}
    </ScrollView>
  );
}

/** The smallest zoom that shows the whole map in a viewport. */
export function superThreadMapFitZoom(
  layout: SuperThreadMapLayout,
  viewport: { readonly width: number; readonly height: number },
) {
  return Math.max(
    SMALLEST_ZOOM,
    Math.min(1, viewport.width / layout.width, viewport.height / layout.height),
  );
}

/**
 * The plan the super agent draws, laid out as on the web, in a strip of the panel. It starts as
 * large as fits, but no smaller than a phone can still read.
 */
export function SuperThreadMap(props: {
  readonly map: SuperThreadMapState;
  readonly layout: SuperThreadMapLayout;
  readonly addedNodeIds: ReadonlySet<string>;
  readonly onOpenThread: (thread: SuperThreadMember) => void;
  readonly onShowNode: (nodeId: string) => void;
}) {
  const { layout } = props;
  const window = useWindowDimensions();
  // The first measured width fixes the starting zoom, so a plan change never resets the user's.
  const [viewport, setViewport] = useState<{
    readonly width: number;
    readonly zoom: number;
  } | null>(null);
  if (props.map.nodes.length === 0) {
    return (
      <Text className="px-2 text-sm text-foreground-muted">
        The agent has not drawn any work yet.
      </Text>
    );
  }
  const zoom = Platform.OS === "ios" ? (viewport?.zoom ?? 1) : 1;
  const height = Math.min(layout.height * zoom, Math.max(240, window.height * 0.55));
  return (
    <View
      accessibilityLabel="Task map"
      className="overflow-hidden rounded-xl border border-border-subtle bg-subtle"
      style={{ height }}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        // A presenting sheet first reports a sliver of its width.
        if (width < SUPER_THREAD_MAP_NODE_WIDTH / 2 || viewport?.width === width) return;
        setViewport({
          width,
          zoom: Math.min(1, Math.max(SUPER_THREAD_MAP_READABLE_ZOOM, width / layout.width)),
        });
      }}
    >
      {viewport === null ? null : (
        <SuperThreadMapViewport
          // Re-applies the starting zoom only when the panel's width changes.
          key={viewport.width}
          layout={layout}
          startZoom={viewport.zoom}
          minimumZoom={Math.min(
            SUPER_THREAD_MAP_READABLE_ZOOM,
            superThreadMapFitZoom(layout, { width: viewport.width, height }),
          )}
        >
          <SuperThreadMapCanvas
            layout={layout}
            addedNodeIds={props.addedNodeIds}
            onOpenThread={props.onOpenThread}
            onShowNode={props.onShowNode}
          />
        </SuperThreadMapViewport>
      )}
    </View>
  );
}
