import {
  configuredSecretSources,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import {
  CloudSpeechApiKey,
  CloudSpeechWhisperModel,
  CloudSpeechWhisperStreamingUrl,
  CloudSpeechWhisperUrl,
  DEFAULT_CLOUD_SPEECH_WHISPER_MODEL,
  isSecretReference,
  type SecretProviderId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { cloudSpeechDisclosure } from "@t3tools/shared/speech";
import * as Schema from "effect/Schema";
import Constants from "expo-constants";
import { useState } from "react";
import { TextInput, View } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import type { EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { pendingCloudVoiceChoice } from "../voice-input/voiceDestination";

const isApiKey = Schema.is(CloudSpeechApiKey);
const isUrl = Schema.is(CloudSpeechWhisperUrl);
const isModel = Schema.is(CloudSpeechWhisperModel);
const isStreamingUrl = Schema.is(CloudSpeechWhisperStreamingUrl);
const FIELD = "rounded-lg bg-background px-3 py-2 text-foreground";

function enableChoice(commit: () => void) {
  try {
    commit();
  } catch {
    Dialog.alert(
      "Could not enable cloud dictation",
      "Check device storage and choose the provider again.",
    );
  }
}

/** Sets up dictation through an OpenAI Whisper-compatible endpoint saved on the environment. */
export function WhisperVoiceEditor({
  environment,
  ready,
  enable,
  canManage,
  onSaved,
  onBack,
}: {
  environment: EnvironmentPresentation;
  /** Whether the environment already has both an endpoint URL and a key. */
  ready: boolean;
  /** Whether saving should also make this device dictate through the endpoint. */
  enable: boolean;
  canManage: boolean;
  onSaved: () => void;
  onBack: () => void;
}) {
  const id = environment.environmentId;
  const settings = environment.serverConfig?.settings;
  const endpoint = settings?.cloudSpeechWhisper ?? {
    url: "",
    model: DEFAULT_CLOUD_SPEECH_WHISPER_MODEL,
    streamingUrl: "",
  };
  const stored = settings?.cloudSpeechCredentials?.whisper;
  const sources =
    Constants.expoConfig?.extra?.secretsFeatureEnabled === true &&
    environment.serverConfig?.secretReferences &&
    settings
      ? configuredSecretSources(settings.secretProviders)
      : [];
  const storedReference =
    isSecretReference(stored) && sources.some((candidate) => candidate.id === stored.provider)
      ? stored
      : null;
  const [url, setUrl] = useState(endpoint.url);
  const [model, setModel] = useState(endpoint.model);
  const [streamingUrl, setStreamingUrl] = useState(endpoint.streamingUrl);
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(
    storedReference?.provider ?? null,
  );
  const [draft, setDraft] = useState(storedReference?.reference ?? "");
  const [saving, setSaving] = useState(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Whisper endpoint",
    reportFailure: false,
  });

  const source = sources.find((candidate) => candidate.id === sourceId);
  const credential =
    sourceId !== null
      ? source && secretRequestReference(source, draft)
      : isApiKey(draft.trim())
        ? draft.trim()
        : undefined;
  const keyChanged =
    credential !== undefined &&
    !(
      isSecretReference(credential) &&
      storedReference?.provider === credential.provider &&
      storedReference.reference === credential.reference
    );
  const nextUrl = url.trim();
  const nextModel = model.trim();
  const urlInvalid = nextUrl !== "" && !isUrl(nextUrl);
  const nextStreamingUrl = streamingUrl.trim();
  const streamingUrlInvalid = !isStreamingUrl(nextStreamingUrl);
  const keyReady = draft.trim() ? credential !== undefined : ready;
  const changed =
    nextUrl !== endpoint.url ||
    nextModel !== endpoint.model ||
    nextStreamingUrl !== endpoint.streamingUrl ||
    keyChanged;
  const canSave =
    nextUrl !== "" &&
    !urlInvalid &&
    !streamingUrlInvalid &&
    isModel(nextModel) &&
    keyReady &&
    (enable || changed);

  const write = async (patch: ServerSettingsPatch, thenEnable: boolean) => {
    if (saving) return;
    const commit = thenEnable ? pendingCloudVoiceChoice(id, "whisper") : null;
    setSaving(true);
    const result = await updateSettings({ environmentId: id, input: { patch } });
    setSaving(false);
    if (result._tag !== "Success")
      return Dialog.alert(
        "Could not save the endpoint",
        "Check the environment connection and your settings permissions.",
      );
    if (commit) enableChoice(commit);
    onSaved();
  };
  const save = () => {
    if (!canSave) return;
    void write(
      {
        cloudSpeechWhisper: { url: nextUrl, model: nextModel, streamingUrl: nextStreamingUrl },
        ...(keyChanged ? { cloudSpeechCredentials: { whisper: credential } } : {}),
      },
      enable,
    );
  };

  return (
    <>
      <Text className="px-2 text-sm text-foreground-muted">
        {cloudSpeechDisclosure("whisper", environment.label)}
      </Text>
      {canManage ? (
        <>
          <ListSection
            title="Endpoint"
            footer={
              urlInvalid
                ? "Enter a full http(s) URL without credentials."
                : streamingUrlInvalid
                  ? "Enter a full wss:// streaming URL without credentials, or leave it empty."
                  : "Recordings are posted to this exact URL with the model below. An optional wss:// streaming URL lets web and desktop send audio while you speak."
            }
          >
            <View className="gap-3 px-4 py-3">
              <TextInput
                accessibilityLabel="Whisper endpoint URL"
                placeholder="https://example.com/v1/audio/transcriptions"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                editable={!saving}
                returnKeyType="done"
                onSubmitEditing={save}
                value={url}
                onChangeText={setUrl}
                className={FIELD}
              />
              <TextInput
                accessibilityLabel="Whisper model"
                placeholder={DEFAULT_CLOUD_SPEECH_WHISPER_MODEL}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                editable={!saving}
                returnKeyType="done"
                onSubmitEditing={save}
                value={model}
                onChangeText={setModel}
                className={FIELD}
              />
              <TextInput
                accessibilityLabel="Whisper streaming URL"
                placeholder="Streaming URL (optional, wss://)"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                editable={!saving}
                returnKeyType="done"
                onSubmitEditing={save}
                value={streamingUrl}
                onChangeText={setStreamingUrl}
                className={FIELD}
              />
            </View>
          </ListSection>
          <ListSection
            title="API key"
            footer={
              draft && !credential
                ? (source?.invalidReferenceMessage ?? "Enter a valid API key.")
                : `Sent as a Bearer token. Anyone with dictation access to ${environment.label} can use it.`
            }
          >
            <View className="gap-3 px-4 py-3">
              {sources.length > 0 && (
                <View className="flex-row flex-wrap gap-2">
                  <Chip
                    label="Value"
                    size="small"
                    selected={sourceId === null}
                    disabled={saving}
                    onPress={() => {
                      setDraft("");
                      setSourceId(null);
                    }}
                  />
                  {sources.map((candidate) => (
                    <Chip
                      key={candidate.id}
                      label={candidate.label}
                      size="small"
                      selected={sourceId === candidate.id}
                      disabled={saving}
                      onPress={() => {
                        setDraft("");
                        setSourceId(candidate.id);
                      }}
                    />
                  ))}
                </View>
              )}
              <TextInput
                key={sourceId ?? "literal"}
                accessibilityLabel={
                  sourceId ? "Whisper endpoint API key reference" : "Whisper endpoint API key"
                }
                placeholder={
                  source?.referencePlaceholder ??
                  (ready ? "Saved key · enter a new one to replace" : "API key")
                }
                secureTextEntry={sourceId === null}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                maxLength={4096}
                editable={!saving}
                returnKeyType="done"
                onSubmitEditing={save}
                value={draft}
                onChangeText={setDraft}
                className={FIELD}
              />
            </View>
          </ListSection>
          <ListSection>
            <ListActionRow
              label={enable ? "Save and enable" : "Save"}
              loading={saving}
              disabled={!canSave}
              onPress={save}
            />
            {ready ? (
              <View className="border-t border-border-subtle">
                <ListActionRow
                  tone="danger"
                  label="Remove endpoint from environment"
                  disabled={saving}
                  onPress={() =>
                    Dialog.confirm({
                      title: `Remove the Whisper-compatible endpoint from ${environment.label}?`,
                      message: "Everyone using it for dictation will lose access.",
                      confirmText: "Remove endpoint",
                      destructive: true,
                      onConfirm: () =>
                        void write(
                          {
                            cloudSpeechWhisper: { url: "", streamingUrl: "" },
                            cloudSpeechCredentials: { whisper: "" },
                          },
                          false,
                        ),
                    })
                  }
                />
              </View>
            ) : null}
          </ListSection>
        </>
      ) : (
        <ListSection>
          <ListActionRow
            label="Ask an administrator to set up the endpoint"
            disabled
            onPress={() => {}}
          />
        </ListSection>
      )}
      <ListSection>
        <ListActionRow label="Back to providers" disabled={saving} onPress={onBack} />
      </ListSection>
    </>
  );
}
