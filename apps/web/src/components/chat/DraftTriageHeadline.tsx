import type { ComponentProps } from "react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useProjects } from "~/state/entities";
import { DraftHeroHeadline } from "./DraftHeroHeadline";

/** The project choice lives in the composer strip, so only a triage draft keeps the hero. */
export function DraftTriageHeadline(props: ComponentProps<typeof DraftHeroHeadline>) {
  const { draftId, activeProjectRef } = props;
  const projects = useProjects();
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
  const isTriageDraft =
    isTriageDraftPrompt &&
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));
  return isTriageDraft ? <DraftHeroHeadline {...props} /> : null;
}
