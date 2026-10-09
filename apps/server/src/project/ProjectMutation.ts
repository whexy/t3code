import { type ProjectMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";
import { WorkspacePathsError } from "../workspace/WorkspacePaths.ts";
import { type ProjectService, type ProjectServiceError } from "./ProjectService.ts";

type ProjectMutations = Pick<ProjectService["Service"], "create" | "delete" | "update">;

export const projectMutationOperation = Effect.fn("projectMutationOperation")(function* (
  projects: ProjectMutations,
  mutation: ProjectMutation,
) {
  switch (mutation.type) {
    case "project.create":
      return yield* projects.create({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        title: mutation.title,
        workspaceRoot: mutation.workspaceRoot,
        ...(mutation.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.update":
      return yield* projects.update({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.workspaceRoot === undefined ? {} : { workspaceRoot: mutation.workspaceRoot }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.autoPull === undefined ? {} : { autoPull: mutation.autoPull }),
        ...(mutation.projectIcon === undefined ? {} : { projectIcon: mutation.projectIcon }),
        ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
        ...(mutation.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.delete":
      return yield* projects.delete({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.force === undefined ? {} : { force: mutation.force }),
      });
  }
});

const isWorkspacePathsError = Schema.is(WorkspacePathsError);

/**
 * Why a project command was refused, in words a client can act on, or
 * undefined for an internal failure whose detail stays in the server log.
 */
export function projectMutationFailureMessage(
  cause: ProjectServiceError | ServerRuntimeStartupError,
): string | undefined {
  switch (cause._tag) {
    case "ProjectNotFoundError":
    case "ProjectConflictError":
    case "ProjectNotEmptyError":
      return cause.message;
    case "ProjectOperationError":
      return cause.operation === "normalize-workspace" && isWorkspacePathsError(cause.cause)
        ? cause.cause.message
        : undefined;
    case "ServerRuntimeStartupError":
      return undefined;
  }
}
