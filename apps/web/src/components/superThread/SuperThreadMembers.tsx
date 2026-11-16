import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, SuperThreadMember } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ListIcon } from "lucide-react";
import { memo } from "react";

import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { SUPER_THREAD_PANEL_ROW_CLASS, SuperThreadPanelHeading } from "./SuperThreadPanelHeading";
import { SuperThreadStatus } from "./SuperThreadStatus";

// Each row reads only its own thread, so other threads' updates leave the list alone.
const SuperThreadMemberItem = memo(function SuperThreadMemberItem(props: {
  readonly member: SuperThreadMember;
  readonly projectDisplayNameByKey: ReadonlyMap<string, string>;
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string>;
}) {
  const { environmentId, threadId } = props.member;
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  const environment = props.environmentLabelById.get(environmentId);
  if (shell === null || shell.deletedAt !== null) {
    return (
      <li className="list-none px-2.5 py-1.5 text-xs text-muted-foreground">
        {shell === null
          ? `A thread on ${environment ?? "another environment"} that this client can't reach right now`
          : "A deleted thread"}
      </li>
    );
  }
  const project = props.projectDisplayNameByKey.get(`${shell.environmentId}:${shell.projectId}`);
  return (
    <li className="list-none">
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId }}
        className={SUPER_THREAD_PANEL_ROW_CLASS}
      >
        <span className="flex h-6 min-w-0 items-center gap-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {shell.title}
          </span>
          {shell.settledOverride === "settled" ? (
            <span className="shrink-0 text-xs text-secondary-label">Settled</span>
          ) : (
            <SuperThreadStatus thread={shell} />
          )}
        </span>
        <span className="mt-0.5 min-w-0 truncate text-xs text-secondary-label">
          {[project, environment].filter(Boolean).join(" · ")}
        </span>
      </Link>
    </li>
  );
});

/** Members, settled ones included; the sidebar shows only unsettled ones. */
export function SuperThreadMembers(props: {
  readonly members: ReadonlyArray<SuperThreadMember>;
  readonly title: "Threads" | "Not on the map";
}) {
  const projectGroups = useSidebarProjectGroups();
  const environments = useEnvironmentIdentities();
  const projectDisplayNameByKey = new Map(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
      ),
    ),
  );
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  if (props.title === "Not on the map" && props.members.length === 0) return null;
  return (
    <section aria-label={props.title} className="space-y-0.5">
      <SuperThreadPanelHeading icon={ListIcon} title={props.title} count={props.members.length} />
      {props.members.length === 0 ? (
        <p className="px-2.5 py-1 text-sm text-muted-foreground">
          Threads the agent launches show up here and in the sidebar.
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {props.members.map((member) => (
            <SuperThreadMemberItem
              key={scopedThreadKey(scopeThreadRef(member.environmentId, member.threadId))}
              member={member}
              projectDisplayNameByKey={projectDisplayNameByKey}
              environmentLabelById={environmentLabelById}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
