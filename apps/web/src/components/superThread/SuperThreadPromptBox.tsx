import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";

import { newMessageId } from "~/lib/utils";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** Sends to the super thread with its own model and modes, as its composer would. */
export function SuperThreadPromptBox(props: { readonly thread: EnvironmentThreadShell }) {
  const { thread } = props;
  const canSend = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();

  const send = async () => {
    if (trimmed.length === 0 || sending || !canSend) return;
    setSending(true);
    setError(null);
    const result = await startTurn({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        message: { messageId: newMessageId(), role: "user", text: trimmed, attachments: [] },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      setText("");
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not send the message.");
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Message the super thread"
          placeholder={
            canSend ? "Steer the work or ask for an update" : "You can't send to this thread"
          }
          rows={1}
          value={text}
          disabled={!canSend}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Button
          type="submit"
          size="icon"
          aria-label="Send"
          disabled={!canSend || sending || trimmed.length === 0}
        >
          <SendIcon aria-hidden />
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
