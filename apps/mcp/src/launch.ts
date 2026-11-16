import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { applyReasoningEffort, resolveModelSelection } from "./agents.ts";
import { BridgeError, type T3Environment } from "./environment.ts";

/** The placeholder title a new thread shows until the server generates one. */
export const sessionTitle = (task: string) => {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
};

/** The project, model and permission mode a new thread starts with, as a new thread in the UI picks them. */
export const resolveLaunch = Effect.fn("resolveLaunch")(function* (
  environment: T3Environment,
  input: {
    readonly projectId: string | null;
    readonly agent?: string | null | undefined;
    readonly model?: string | null | undefined;
    readonly reasoningEffort?: string | null | undefined;
  },
) {
  const scratch = input.projectId === null;
  // The scratch project must exist before the shell is read, so the shell lists it.
  const projectId = input.projectId ?? (yield* environment.ensureScratchProject).projectId;
  const [shell, config] = yield* Effect.all([environment.shell, environment.serverConfig], {
    concurrency: 2,
  });
  const project = shell.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return yield* new BridgeError({
      message: scratch
        ? `T3 server "${environment.id}" prepared its scratch project ${projectId}, but it is no longer available. Try again.`
        : `Project ${projectId} was not found on server "${environment.id}". Call list_projects for current ids.`,
    });
  }
  const settings = resolveProjectSettings(config.settings, project.id, project).settings;
  const selection = resolveModelSelection({
    providers: config.providers,
    projectDefault: settings.defaultModelSelection,
    agent: input.agent ?? undefined,
    model: input.model ?? undefined,
  });
  if (Result.isFailure(selection)) {
    return yield* new BridgeError({ message: selection.failure });
  }
  const withEffort =
    input.reasoningEffort == null
      ? selection
      : applyReasoningEffort({
          providers: config.providers,
          selection: selection.success,
          reasoningEffort: input.reasoningEffort,
        });
  if (Result.isFailure(withEffort)) {
    return yield* new BridgeError({ message: withEffort.failure });
  }
  return {
    project,
    modelSelection: withEffort.success,
    runtimeMode: settings.defaultRuntimeMode,
  };
});
