import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  getProviderAttachmentLimitError,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import { SendIcon, XIcon } from "lucide-react";
import { useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";

import { readFileAsDataUrl } from "~/lib/imageCompression";
import { newMessageId, randomUUID } from "~/lib/utils";
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
  // Pasted screenshots, so the person can point at the task map while steering.
  const [images, setImages] = useState<ReadonlyArray<UploadChatImageAttachment & { key: string }>>(
    [],
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();
  const canSubmit = canSend && !sending && (trimmed.length > 0 || images.length > 0);

  const send = async () => {
    if (!canSubmit) return;
    const limitError = getProviderAttachmentLimitError(images);
    if (limitError !== undefined) {
      setError(limitError);
      return;
    }
    setSending(true);
    setError(null);
    const result = await startTurn({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: trimmed,
          attachments: images.map(({ key: _key, ...image }) => image),
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      setText("");
      setImages([]);
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not send the message.");
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    event.preventDefault();
    void Promise.all(
      files.map(async (file) => ({
        key: randomUUID(),
        type: "image" as const,
        name: file.name || "screenshot.png",
        mimeType: file.type,
        sizeBytes: file.size,
        dataUrl: await readFileAsDataUrl(file),
      })),
    ).then(
      (pasted) => setImages((current) => [...current, ...pasted]),
      () => setError("Could not read the pasted image."),
    );
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
      {images.length > 0 ? (
        <ul aria-label="Pasted images" className="flex flex-wrap gap-2">
          {images.map((image) => (
            <li key={image.key} className="relative">
              <img
                src={image.dataUrl}
                alt={image.name}
                className="size-14 rounded-md border border-border object-cover"
              />
              <Button
                type="button"
                size="icon-xs"
                variant="secondary"
                aria-label={`Remove ${image.name}`}
                className="absolute -top-1.5 -right-1.5"
                onClick={() =>
                  setImages((current) => current.filter((entry) => entry.key !== image.key))
                }
              >
                <XIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
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
          onPaste={handlePaste}
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={!canSubmit}>
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
