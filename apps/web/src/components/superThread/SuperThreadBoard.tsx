import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SUPER_THREAD_BOARD_COLUMNS,
  groupSuperThreadBoardItems,
} from "@t3tools/client-runtime/state/super-thread-presentation";
import type {
  SuperThreadBoard as SuperThreadBoardState,
  SuperThreadMember,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { useQuietThreadShell } from "../../state/entities";
import { InlineButton } from "../ui/button";

// Each link reads only its own thread, so other threads' updates leave the board alone.
function SuperThreadBoardLink(props: { readonly member: SuperThreadMember }) {
  const { environmentId, threadId } = props.member;
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  return (
    <InlineButton
      tone="muted"
      className="max-w-full"
      render={<Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />}
    >
      <span className="min-w-0 truncate">{shell?.title ?? "Open thread"}</span>
    </InlineButton>
  );
}

/** The goal board the super agent writes; people only read it. */
export function SuperThreadBoard(props: { readonly board: SuperThreadBoardState }) {
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
                      {item.members.map((member) => (
                        <li
                          key={scopedThreadKey(
                            scopeThreadRef(member.environmentId, member.threadId),
                          )}
                          className="min-w-0"
                        >
                          <SuperThreadBoardLink member={member} />
                        </li>
                      ))}
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
