import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SUPER_THREAD_MAP_METRICS,
  SUPER_THREAD_MAP_STATE_LABELS,
  layoutSuperThreadMap,
  resolveSuperThreadMapNodeState,
  type SuperThreadMapLayout,
  type SuperThreadMapLayoutNode,
  type SuperThreadMapMetrics,
  type SuperThreadMapNodeState,
} from "@t3tools/client-runtime/state/super-thread-map";
import type {
  EnvironmentId,
  SuperThreadMap as SuperThreadMapState,
  SuperThreadMember,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { memo, useMemo, useState, type ReactNode } from "react";
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

// Narrow gaps, so two columns fit a phone or an iPad panel at about full size.
const MOBILE_METRICS: SuperThreadMapMetrics = {
  ...SUPER_THREAD_MAP_METRICS,
  nodeWidth: 196,
  minNodeWidth: 132,
  nodeHeight: 90,
  columnGap: 28,
  rowGap: 16,
  laneGap: 14,
  laneHeader: 28,
  lanePadding: 0,
  margin: 4,
  sideBend: 22,
  // Edge labels show in a node's details instead.
  sideLabelWidth: 0,
};

const NARROW_NODE_WIDTH = 160;
const NARROW_NODE_HEIGHT = 108;
const TITLE_LINE_HEIGHT = 17;

/** The map laid out at the sizes mobile draws it, with cards as wide as `width` allows. */
export function layoutMobileSuperThreadMap(
  map: Pick<SuperThreadMapState, "nodes" | "edges">,
  width: number,
  margin = MOBILE_METRICS.margin,
): SuperThreadMapLayout {
  const metrics = { ...MOBILE_METRICS, margin };
  const layout = layoutSuperThreadMap(map, { availableWidth: width, metrics });
  // Narrow cards get a fourth title line rather than cutting the title short.
  return layout.nodeWidth < NARROW_NODE_WIDTH
    ? layoutSuperThreadMap(map, {
        availableWidth: width,
        metrics: { ...metrics, nodeHeight: NARROW_NODE_HEIGHT },
      })
    : layout;
}

// Readable on a phone while still showing more than one column.
export const SUPER_THREAD_MAP_READABLE_ZOOM = 0.8;
const SMALLEST_ZOOM = 0.25;
const LARGEST_ZOOM = 2.5;
const ARROW_ID = "super-thread-map-arrow";

const SuperThreadMapNode = memo(function SuperThreadMapNode(props: {
  readonly placed: SuperThreadMapLayoutNode;
  readonly width: number;
  readonly height: number;
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
        "absolute gap-1 rounded-2xl border bg-card px-3 pt-2.5",
        state === "needs-you" ? "border-adaptive-indigo-600-300" : "border-border",
        state === "dropped" && "opacity-55",
      )}
      style={({ pressed }) => [
        {
          left: x,
          top: y,
          width: props.width,
          height: props.height,
          borderStyle: state === "planned" ? "dashed" : "solid",
          borderWidth: StyleSheet.hairlineWidth * 2,
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
          numberOfLines={1}
          className={cn("shrink text-xs font-t3-medium", presentation.className)}
        >
          {SUPER_THREAD_MAP_STATE_LABELS[state]}
          {threadCount > 1 ? (
            <Text className="font-t3-regular text-foreground-muted"> · {threadCount}</Text>
          ) : null}
        </Text>
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
        // Padding, the status line and the gap take about 36pt; the rest holds title lines.
        numberOfLines={Math.max(1, Math.floor((props.height - 36) / TITLE_LINE_HEIGHT))}
        className={cn(
          "text-sm leading-[17px] font-t3-medium text-foreground",
          state === "dropped" && "line-through",
        )}
      >
        {node.title}
      </Text>
    </Pressable>
  );
});

/**
 * Two nodes stacked next to each other in a column are joined by a short line between them; the
 * shared layout's bow out to their right reads as a line to nowhere in a narrow panel.
 */
function stackedEdgePath(
  layout: SuperThreadMapLayout,
  edge: SuperThreadMapLayout["edges"][number],
): string | null {
  const from = layout.nodes.find((placed) => placed.node.id === edge.from);
  const to = layout.nodes.find((placed) => placed.node.id === edge.to);
  if (from === undefined || to === undefined || from.x !== to.x) return null;
  const { nodeWidth } = layout;
  const { nodeHeight, rowGap } = layout.metrics;
  const [upper, lower] = from.y < to.y ? [from, to] : [to, from];
  if (lower.y - upper.y !== nodeHeight + rowGap) return null;
  const x = upper.x + nodeWidth / 2;
  return `M${x},${upper.y + nodeHeight} L${x},${lower.y}`;
}

export function SuperThreadMapCanvas(props: {
  readonly layout: SuperThreadMapLayout;
  readonly addedNodeIds: ReadonlySet<string>;
  readonly onOpenThread: (thread: SuperThreadMember) => void;
  readonly onShowNode: (nodeId: string) => void;
}) {
  const { layout } = props;
  const { metrics } = layout;
  const edgeColor = StyleSheet.flatten(useResolveClassNames("text-foreground-muted"))?.color;
  const onPressNode = (nodeId: string, only: SuperThreadMember | null) =>
    only === null ? props.onShowNode(nodeId) : props.onOpenThread(only);
  return (
    <View style={{ width: layout.width, height: layout.height }}>
      {/* A lane is headed like the thread list's own groups: a label and a rule. */}
      {layout.lanes.map((lane) =>
        lane.group === null ? null : (
          <View
            key={lane.group}
            className="absolute flex-row items-center gap-2.5"
            style={{ top: lane.y, left: metrics.margin, right: metrics.margin, height: 18 }}
          >
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              className="shrink text-xs font-t3-medium text-foreground-tertiary"
            >
              {lane.group}
            </Text>
            <View className="h-px flex-1 bg-border" />
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
            d={stackedEdgePath(layout, edge) ?? edge.path}
            fill="none"
            stroke={edgeColor}
            strokeOpacity={0.55}
            strokeWidth={1.25}
            {...(edge.kind === "depends"
              ? { markerEnd: `url(#${ARROW_ID})` }
              : { strokeDasharray: "3 3" })}
          />
        ))}
      </Svg>
      {layout.nodes.map((placed) => (
        <SuperThreadMapNode
          key={placed.node.id}
          placed={placed}
          width={layout.nodeWidth}
          height={metrics.nodeHeight}
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
  /** Fills this height at the starting zoom, so a short map sits at the top, not the middle. */
  readonly fillHeight?: number;
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
      contentContainerStyle={{
        width: props.layout.width,
        height: Math.max(props.layout.height, (props.fillHeight ?? 0) / props.startZoom),
      }}
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
 * The plan the super agent draws, the same diagram as on the web, in a strip of the panel. It
 * starts as large as fits, but no smaller than a phone can still read.
 */
export function SuperThreadMap(props: {
  readonly map: SuperThreadMapState;
  readonly addedNodeIds: ReadonlySet<string>;
  readonly onOpenThread: (thread: SuperThreadMember) => void;
  readonly onShowNode: (nodeId: string) => void;
}) {
  const window = useWindowDimensions();
  // The first measured width fixes the starting zoom, so a plan change never resets the user's.
  const [viewport, setViewport] = useState<{
    readonly width: number;
    readonly zoom: number;
  } | null>(null);
  const layout = useMemo(
    () => (viewport === null ? null : layoutMobileSuperThreadMap(props.map, viewport.width)),
    [props.map, viewport],
  );
  if (props.map.nodes.length === 0) {
    return (
      <Text className="px-2 text-sm text-foreground-muted">
        The agent has not drawn any work yet.
      </Text>
    );
  }
  const zoom = Platform.OS === "ios" ? (viewport?.zoom ?? 1) : 1;
  // A map that fits the width shows whole and scrolls with the panel; a wider one gets a strip
  // to pan in.
  const height =
    layout === null || viewport === null
      ? 1
      : layout.width * zoom <= viewport.width + 1
        ? layout.height * zoom
        : Math.min(layout.height * zoom, Math.max(240, window.height * 0.55));
  return (
    <View
      accessibilityLabel="Task map"
      className="overflow-hidden"
      style={{ height }}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        // A presenting sheet first reports a sliver of its width.
        if (width < MOBILE_METRICS.minNodeWidth / 2 || viewport?.width === width) return;
        const measured = layoutMobileSuperThreadMap(props.map, width);
        setViewport({
          width,
          zoom: Math.min(1, Math.max(SUPER_THREAD_MAP_READABLE_ZOOM, width / measured.width)),
        });
      }}
    >
      {viewport === null || layout === null ? null : (
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
