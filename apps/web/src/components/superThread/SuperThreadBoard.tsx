import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  SUPER_THREAD_BOARD_COLUMNS,
  groupSuperThreadBoardItems,
} from "@t3tools/client-runtime/state/super-thread-presentation";
import type { SuperThreadBoard as SuperThreadBoardState } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { InlineButton } from "../ui/button";

/** The goal board the super agent writes; people only read it. */
export function SuperThreadBoard(props: {
  readonly board: SuperThreadBoardState;
  readonly shellByKey: ReadonlyMap<string, EnvironmentThreadShell>;
}) {
  const columns = groupSuperThreadBoardItems(props.board.items);
  return (
    <section aria-label="Goal board" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Board</h2>
      {props.board.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">The agent has not added any work items yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SUPER_THREAD_BOARD_COLUMNS.map(({ status, label }) => (
            <section
              key={status}
              aria-label={label}
              className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/40 p-2"
            >
              <h3 className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                {label}
                <span className="tabular-nums">{columns[status].length}</span>
              </h3>
              {columns[status].map((item) => (
                <article
                  key={item.id}
                  className="flex flex-col gap-1 rounded-md border border-border bg-background p-2.5 text-sm"
                >
                  <p className="font-medium text-foreground">{item.title}</p>
                  {item.note ? (
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">{item.note}</p>
                  ) : null}
                  {item.members && item.members.length > 0 ? (
                    <ul className="flex flex-col gap-0.5 text-xs">
                      {item.members.map((member) => {
                        const key = scopedThreadKey(
                          scopeThreadRef(member.environmentId, member.threadId),
                        );
                        return (
                          <li key={key} className="min-w-0 truncate">
                            <InlineButton
                              tone="muted"
                              render={
                                <Link
                                  to="/$environmentId/$threadId"
                                  params={{
                                    environmentId: member.environmentId,
                                    threadId: member.threadId,
                                  }}
                                />
                              }
                            >
                              {props.shellByKey.get(key)?.title ?? "Open thread"}
                            </InlineButton>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
