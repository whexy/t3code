import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, SuperThreadMember } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
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
      <li className="px-3 py-2 text-xs text-muted-foreground">
        {shell === null
          ? `A thread on ${environment ?? "another environment"} that this client can't reach right now`
          : "A deleted thread"}
      </li>
    );
  }
  const project = props.projectDisplayNameByKey.get(`${shell.environmentId}:${shell.projectId}`);
  return (
    <li>
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId }}
        className="flex items-center gap-3 px-3 py-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-foreground">{shell.title}</span>
          <span className="truncate text-xs text-secondary-label">
            {[project, environment].filter(Boolean).join(" · ")}
          </span>
        </span>
        {shell.settledOverride === "settled" ? (
          <span className="shrink-0 text-xs text-secondary-label">Settled</span>
        ) : (
          <SuperThreadStatus thread={shell} />
        )}
      </Link>
    </li>
  );
});

/** Every member, settled ones included; the sidebar shows only unsettled ones. */
export function SuperThreadMembers(props: { readonly members: ReadonlyArray<SuperThreadMember> }) {
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
  return (
    <section aria-label="Threads" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Threads</h2>
      {props.members.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Threads the agent launches show up here and in the sidebar.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
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
