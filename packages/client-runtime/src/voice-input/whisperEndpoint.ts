import {
  isManagedSettingPath,
  type ManagedPolicySummary,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

type WhisperEndpointPatch = NonNullable<ServerSettingsPatch["cloudSpeechWhisper"]>;
export type WhisperEndpointLocks = Readonly<Record<keyof WhisperEndpointPatch, string | undefined>>;

/** "Managed by <organization>." for each Whisper endpoint field the environment's policy locks. */
export function whisperEndpointLocks(
  policy: ManagedPolicySummary | undefined,
): WhisperEndpointLocks {
  const reason = (field: keyof WhisperEndpointPatch) =>
    policy !== undefined && isManagedSettingPath(policy, `cloudSpeechWhisper.${field}`)
      ? `Managed by ${policy.organization}.`
      : undefined;
  return { url: reason("url"), model: reason("model"), streamingUrl: reason("streamingUrl") };
}

/** The server refuses a write that changes a locked field, so saves leave those out. */
export function unlockedWhisperEndpointPatch(
  locks: WhisperEndpointLocks,
  { url, model, streamingUrl }: WhisperEndpointPatch,
): WhisperEndpointPatch {
  return {
    ...(locks.url === undefined && url !== undefined ? { url } : {}),
    ...(locks.model === undefined && model !== undefined ? { model } : {}),
    ...(locks.streamingUrl === undefined && streamingUrl !== undefined ? { streamingUrl } : {}),
  };
}
