import { describe, expect, it } from "@effect/vitest";
import {
  OrchestrationV2ShellSnapshot,
  ProjectId,
  type OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { T3Environment } from "./environment.ts";
import {
  appThread,
  bridgeLayer,
  callTool,
  fakeEnvironment,
  NOW,
  projection,
  serverConfig,
} from "./testing.ts";

const project = (id: string) => ({
  id,
  title: id,
  workspaceRoot: `/srv/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
});
const shell = Schema.decodeSync(OrchestrationV2ShellSnapshot)({
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [project("scratch"), project("app")],
  threads: [],
  archivedThreads: [],
});

function server(overrides: Partial<T3Environment> = {}) {
  const launches: Array<OrchestrationV2ThreadLaunchInput> = [];
  const environment = fakeEnvironment({
    shell: Effect.succeed(shell),
    serverConfig: Effect.succeed(serverConfig),
    launchThread: (input) =>
      Effect.sync(() => {
        launches.push(input);
        return projection({ thread: appThread({ id: input.threadId! }) });
      }),
    ...overrides,
  });
  return { launches, layer: bridgeLayer(environment) };
}

describe("create_super_thread", () => {
  it.effect(
    "launches a super thread in the scratch folder with the task as its first message",
    () => {
      const { launches, layer } = server({
        ensureScratchProject: Effect.succeed({ projectId: ProjectId.make("scratch") }),
      });
      return Effect.gen(function* () {
        const created = yield* callTool("create_super_thread", {
          server_id: "home",
          task: "Ship the release across web and mobile",
        });
        expect(created).toMatchObject({ project_id: "scratch", agent: "codex", state: "queued" });
        expect(launches).toMatchObject([
          {
            projectId: "scratch",
            superThread: true,
            creationSource: "mcp",
            workspaceStrategy: { type: "root" },
            threadId: created.session_id,
            initialMessage: { text: "Ship the release across web and mobile", attachments: [] },
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("runs in a given project without preparing the scratch folder", () => {
    // fakeEnvironment dies if ensureScratchProject is read.
    const { launches, layer } = server();
    return Effect.gen(function* () {
      yield* callTool("create_super_thread", { server_id: "home", project_id: "app", task: "Go" });
      expect(launches).toMatchObject([{ projectId: "app", superThread: true }]);
    }).pipe(Effect.provide(layer));
  });
});
