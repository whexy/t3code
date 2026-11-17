import { getCloudSpeechKeys } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  CloudSpeechWhisperModel,
  CloudSpeechWhisperStreamingUrl,
  CloudSpeechWhisperUrl,
  isSecretReference,
  type SecretReference,
  type ServerSettingsPatch,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { cloudSpeechDisclosure } from "@t3tools/shared/speech";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { chooseAudioDestination, pendingCloudAudioChoice } from "../../speech/voiceConsent";
import type { EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useCloudRead } from "./CloudVoiceConfiguration";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

const isApiKey = Schema.is(CloudSpeechApiKey);
const isUrl = Schema.is(CloudSpeechWhisperUrl);
const isStreamingUrl = Schema.is(CloudSpeechWhisperStreamingUrl);
const isModel = Schema.is(CloudSpeechWhisperModel);
const sameReference = (a: SettingsSecretValue, b: SettingsSecretValue) =>
  isSecretReference(a) &&
  isSecretReference(b) &&
  a.provider === b.provider &&
  a.reference === b.reference;

/** Sets up dictation through an OpenAI Whisper-compatible endpoint saved on the environment. */
export function WhisperVoiceConfiguration({
  environment,
  active,
  close,
}: {
  environment: Pick<EnvironmentPresentation, "environmentId" | "label">;
  active: boolean;
  close: () => void;
}) {
  const id = environment.environmentId;
  const formId = useId();
  const prepared = Option.getOrNull(usePreparedConnection(id));
  const canUse = useEnvironmentScope(id, AuthOrchestrationOperateScope);
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const [presence, refresh] = useCloudRead(canUse ? prepared : null, getCloudSpeechKeys);
  const endpoint = useEnvironmentSettings(id, (settings) => settings.cloudSpeechWhisper);
  const storedKey = useEnvironmentSettings(
    id,
    (settings) => settings.cloudSpeechCredentials.whisper,
  );
  const sources = useSecretSources(id);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Whisper endpoint",
    reportFailure: false,
  });
  const [url, setUrl] = useState(endpoint.url);
  const [model, setModel] = useState(endpoint.model);
  const [streamingUrl, setStreamingUrl] = useState(endpoint.streamingUrl);
  const [key, setKey] = useState<string | SecretReference>(
    isSecretReference(storedKey) ? storedKey : "",
  );
  const [keyValid, setKeyValid] = useState(true);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const connected = canUse && prepared !== null;
  const ready = AsyncResult.isSuccess(presence) ? presence.value?.whisper : undefined;
  const nextUrl = url.trim();
  const nextModel = model.trim();
  const nextStreamingUrl = streamingUrl.trim();
  const streamingUrlInvalid = !isStreamingUrl(nextStreamingUrl);
  const credential = typeof key === "string" ? key.trim() || undefined : key;
  const keyChanged = credential !== undefined && !sameReference(credential, storedKey);
  const keyReady =
    credential === undefined
      ? Boolean(ready)
      : keyValid && (typeof credential !== "string" || isApiKey(credential));
  const endpointChanged =
    nextUrl !== endpoint.url ||
    nextModel !== endpoint.model ||
    nextStreamingUrl !== endpoint.streamingUrl;
  const urlInvalid = nextUrl !== "" && !isUrl(nextUrl);
  const canSave =
    connected &&
    canManage &&
    nextUrl !== "" &&
    !urlInvalid &&
    !streamingUrlInvalid &&
    isModel(nextModel) &&
    keyReady &&
    (!active || endpointChanged || keyChanged);
  const destination = { kind: "cloud", provider: "whisper", environmentId: id } as const;

  const write = async (patch: ServerSettingsPatch, thenEnable: boolean) => {
    if (!connected || !canManage || busy) return;
    setError("");
    setBusy(true);
    const commit = thenEnable ? pendingCloudAudioChoice(destination) : null;
    const result = await updateSettings({ environmentId: id, input: { patch } });
    setBusy(false);
    if (result._tag !== "Success")
      return setError("Couldn’t save this change. Check your connection and try again.");
    refresh();
    commit?.();
    close();
  };
  const save = () => {
    if (!canSave) return;
    void write(
      {
        cloudSpeechWhisper: { url: nextUrl, model: nextModel, streamingUrl: nextStreamingUrl },
        ...(keyChanged ? { cloudSpeechCredentials: { whisper: credential } } : {}),
      },
      !active,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {remove
              ? "Remove the Whisper-compatible endpoint?"
              : active
                ? "Manage Whisper-compatible endpoint"
                : "Use a Whisper-compatible endpoint for dictation?"}
          </DialogTitle>
          <DialogDescription>
            {remove
              ? `Everyone using it for dictation on ${environment.label} will lose access.`
              : cloudSpeechDisclosure("whisper", environment.label)}
          </DialogDescription>
        </DialogHeader>
        {!remove && (
          <DialogPanel>
            {!connected ? (
              <p>Connect to {environment.label} with dictation access to continue.</p>
            ) : AsyncResult.isFailure(presence) ? (
              <Button size="sm" variant="outline" onClick={refresh}>
                Retry loading the endpoint
              </Button>
            ) : !AsyncResult.isSuccess(presence) || !presence.value ? (
              <p role="status">Checking the endpoint…</p>
            ) : ready === undefined ? (
              <p>Update {environment.label} to use a Whisper-compatible endpoint.</p>
            ) : canManage ? (
              <form
                id={formId}
                className="grid gap-3"
                // The fields validate trimmed URLs; native url checks would block a stray space silently.
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  save();
                }}
              >
                <fieldset disabled={busy} className="contents">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${formId}-url`}>Endpoint URL</Label>
                    <Input
                      id={`${formId}-url`}
                      type="url"
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="https://example.com/v1/audio/transcriptions"
                      aria-invalid={urlInvalid}
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                    <p className="text-sm text-muted-foreground">
                      {urlInvalid
                        ? "Enter a full http(s) URL without credentials."
                        : "Recordings are posted to this exact URL."}
                    </p>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${formId}-model`}>Model</Label>
                    <Input
                      id={`${formId}-model`}
                      autoComplete="off"
                      spellCheck={false}
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${formId}-streaming-url`}>Streaming URL (optional)</Label>
                    <Input
                      id={`${formId}-streaming-url`}
                      type="url"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="wss://example.com/v1/realtime?intent=transcription"
                      aria-invalid={streamingUrlInvalid}
                      value={streamingUrl}
                      onChange={(event) => setStreamingUrl(event.target.value)}
                    />
                    <p className="text-sm text-muted-foreground">
                      {streamingUrlInvalid
                        ? "Enter a full wss:// URL without credentials."
                        : "When set, audio streams while you speak, so text is ready soon after you stop."}
                    </p>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${formId}-key`}>{ready ? "Replace API key" : "API key"}</Label>
                    <SecretSourceInput
                      id={`${formId}-key`}
                      aria-label="Whisper endpoint API key"
                      placeholder="Enter API key"
                      environmentId={id}
                      configured={Boolean(ready) && !isSecretReference(storedKey)}
                      maxLength={4096}
                      value={key}
                      sources={sources}
                      onChange={(event) => setKey(event.target.value)}
                      onSecretChange={(secret) => setKey(secret ?? "")}
                      onValidityChange={setKeyValid}
                    />
                    <p className="text-sm text-muted-foreground">
                      {typeof credential === "string" && !isApiKey(credential)
                        ? "Enter an API key, not a URL or secret reference."
                        : ready
                          ? "Leave blank to keep the saved key. It is sent as a Bearer token."
                          : `Sent as a Bearer token. Anyone with dictation access to ${environment.label} can use it.`}
                    </p>
                  </div>
                </fieldset>
              </form>
            ) : ready ? (
              <p className="text-sm text-muted-foreground">
                Sends recordings to {endpoint.url || "the configured endpoint"}. This choice applies
                only to this device. Choose Off to stop sharing.
              </p>
            ) : (
              <p>Ask an administrator on {environment.label} to set up the endpoint.</p>
            )}
          </DialogPanel>
        )}
        {error && (
          <p className="px-6 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          {connected && canManage && ready && !remove && (
            <div className="sm:mr-auto">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setRemove(true)}
              >
                Remove endpoint…
              </Button>
            </div>
          )}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {connected &&
            (remove ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void write(
                    {
                      cloudSpeechWhisper: { url: "", streamingUrl: "" },
                      cloudSpeechCredentials: { whisper: "" },
                    },
                    false,
                  )
                }
              >
                Remove endpoint
              </Button>
            ) : canManage && ready !== undefined ? (
              <Button type="submit" form={formId} size="sm" disabled={busy || !canSave}>
                {active ? "Save" : "Save and enable"}
              </Button>
            ) : ready && !active ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  chooseAudioDestination(destination);
                  close();
                }}
              >
                Use Whisper-compatible
              </Button>
            ) : null)}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
