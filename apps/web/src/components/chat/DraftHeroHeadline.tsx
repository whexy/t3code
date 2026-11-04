import type { DraftId } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import { useScratchProject } from "~/hooks/useScratchProject";
import { isTriagePrompt } from "~/hooks/useStartTriage";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { TriageDraftHero } from "./TriageDraftHero";

/** Only a triage draft gets a hero; the project choice lives in the composer strip. */
export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
}: {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
}) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { scratchWorkspaceRootFor } = useScratchProject();
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  if (
    !isTriageDraftPrompt ||
    activeProject === null ||
    !isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId))
  ) {
    return null;
  }
  const environment = environments.find(
    (entry) => entry.environmentId === activeProject.environmentId,
  );
  return (
    <TriageDraftHero
      machineLabel={environment?.label ?? null}
      serverVersion={environment?.serverConfig?.environment.serverVersion ?? null}
    />
  );
}
