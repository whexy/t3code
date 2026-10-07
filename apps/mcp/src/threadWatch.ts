import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { BridgeError } from "./errors.ts";

/** The first projection, from the subscription's snapshot and replayed events, that is `ready`. */
export const waitForThreadState = <E, R>(
  updates: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>,
  ready: (projection: OrchestrationV2ThreadProjection) => boolean,
) =>
  Effect.suspend(() => {
    let current: OrchestrationV2ThreadProjection | null = null;
    return updates.pipe(
      Stream.map((item) => {
        if (item.kind === "snapshot") current = item.projection;
        if (item.kind === "event")
          current = applyOrchestrationV2ProjectionEvent(current, item.event);
        return current;
      }),
      Stream.filter(
        (projection): projection is OrchestrationV2ThreadProjection =>
          projection !== null && ready(projection),
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new BridgeError({
                message: "The session subscription ended before the session was ready.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  });
