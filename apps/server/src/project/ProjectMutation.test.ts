import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { WorkspaceRootCreateFailedError } from "../workspace/WorkspacePaths.ts";
import { projectMutationFailureMessage } from "./ProjectMutation.ts";
import { ProjectConflictError, ProjectOperationError } from "./ProjectService.ts";

const projectId = ProjectId.make("project:mutation-mapping");

it("names the reason a client can fix and keeps internal failures generic", () => {
  const conflictingProjectId = ProjectId.make("project:existing");
  assert.equal(
    projectMutationFailureMessage(
      new ProjectConflictError({
        projectId,
        workspaceRoot: "/work/taken",
        conflictingProjectId,
      }),
    ),
    "Workspace /work/taken already belongs to project project:existing.",
  );
  assert.equal(
    projectMutationFailureMessage(
      new ProjectOperationError({
        operation: "normalize-workspace",
        projectId,
        workspaceRoot: "/root/denied",
        cause: new WorkspaceRootCreateFailedError({
          workspaceRoot: "/root/denied",
          normalizedWorkspaceRoot: "/root/denied",
          cause: new Error("EACCES"),
        }),
      }),
    ),
    "Failed to create workspace root: /root/denied",
  );
  assert.isUndefined(
    projectMutationFailureMessage(
      new ProjectOperationError({
        operation: "dispatch-project-command",
        projectId,
        cause: new Error("SQLITE_BUSY"),
      }),
    ),
  );
});
