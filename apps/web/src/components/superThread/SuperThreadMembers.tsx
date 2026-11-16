import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, SuperThreadMember } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { SuperThreadStatus } from "./SuperThreadStatus";

/** Every member this client holds, settled ones included; the sidebar shows only unsettled ones. */
export function SuperThreadMembers(props: {
  readonly members: ReadonlyArray<SuperThreadMember>;
  readonly shellByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly projectDisplayNameByKey: ReadonlyMap<string, string>;
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string>;
}) {
  const held = props.members.flatMap((member) => {
    const shell = props.shellByKey.get(
      scopedThreadKey(scopeThreadRef(member.environmentId, member.threadId)),
    );
    return shell === undefined || shell.deletedAt !== null ? [] : [shell];
  });
  const missing = props.members.length - held.length;
  return (
    <section aria-label="Threads" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Threads</h2>
      {props.members.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Threads the agent launches show up here and in the sidebar.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {held.map((shell) => {
            const project = props.projectDisplayNameByKey.get(
              `${shell.environmentId}:${shell.projectId}`,
            );
            const environment = props.environmentLabelById.get(shell.environmentId);
            const settled = shell.settledOverride === "settled";
            return (
              <li key={scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))}>
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId: shell.environmentId, threadId: shell.id }}
                  className="flex items-center gap-3 px-3 py-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-foreground">{shell.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {[project, environment].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {settled ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Settled</span>
                  ) : (
                    <SuperThreadStatus thread={shell} />
                  )}
                </Link>
              </li>
            );
          })}
          {missing > 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {missing} more on environments this client can't reach right now.
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
