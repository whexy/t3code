import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { environmentThreadDetails } from "../../state/threads";
import { InlineButton } from "../ui/button";
import { ChildApproval } from "../chat/ChildThreadApprovals";

/**
 * The super agent's own approvals, answered here. Its questions are only shown: answering one
 * needs the composer's multi-step answer flow, so they link to the transcript.
 */
export function SuperThreadPendingRequests(props: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
}) {
  const pending = useAtomValue(environmentThreadDetails.pendingRequestsAtom(props.threadRef));
  const approvals = pending?.approvals ?? [];
  const userInputs = pending?.userInputs ?? [];
  if (approvals.length === 0 && userInputs.length === 0) return null;
  return (
    <section aria-label="Waiting for you" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Waiting for you</h2>
      {approvals.map((approval) => (
        <ChildApproval
          key={approval.requestId}
          entry={{ thread: props.threadRef, title: props.title, approval }}
        />
      ))}
      {userInputs.map((input) => (
        <section
          key={input.requestId}
          aria-label="Question from the agent"
          className="rounded-lg border border-border bg-background p-3 text-xs"
        >
          <ul className="flex flex-col gap-2">
            {input.questions.map((question) => (
              <li key={question.id}>
                <p className="font-medium text-foreground">{question.question}</p>
                {question.options.length > 0 ? (
                  <p className="mt-0.5 text-muted-foreground">
                    {question.options.map((option) => option.label).join(" · ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <InlineButton
            className="mt-2"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{
                  environmentId: props.threadRef.environmentId,
                  threadId: props.threadRef.threadId,
                }}
              />
            }
          >
            Answer in the transcript
          </InlineButton>
        </section>
      ))}
    </section>
  );
}
