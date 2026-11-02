import {
  isProviderAvailable,
  type ModelSelection,
  type SelectProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue, resolveSelectableModel } from "@t3tools/shared/model";
import * as Result from "effect/Result";

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Ids drivers give their reasoning effort select: Codex and Grok
 * `reasoningEffort`, Claude `effort`, Cursor `reasoning`, OpenCode `variant`.
 * The web settings page recognizes the same set. Other selects, such as
 * `contextWindow`, can come first, so position is not a signal.
 */
const REASONING_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set([
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
]);

const isSelectable = (provider: ServerProvider) =>
  provider.enabled && provider.installed && isProviderAvailable(provider);

const defaultModel = (provider: ServerProvider): ServerProviderModel | undefined =>
  provider.models.find((model) => model.isDefault === true) ??
  provider.models.find((model) => model.isLegacy !== true) ??
  provider.models[0];

const agentLabel = (provider: ServerProvider) =>
  provider.displayName === undefined
    ? provider.instanceId
    : `${provider.instanceId} (${provider.displayName})`;

/** The agents a session can use on one server, current models first. */
export function summarizeAgents(providers: ReadonlyArray<ServerProvider>) {
  return providers.filter(isSelectable).map((provider) => {
    const fallback = defaultModel(provider);
    const ordered = [
      ...(fallback === undefined ? [] : [fallback]),
      ...provider.models.filter((model) => model !== fallback && model.isLegacy !== true),
      ...provider.models.filter((model) => model !== fallback && model.isLegacy === true),
    ];
    return {
      agent: provider.instanceId,
      name: provider.displayName ?? provider.instanceId,
      status: provider.status,
      ...(provider.status !== "ready" && provider.message !== undefined
        ? { message: provider.message }
        : {}),
      default_model: fallback?.slug ?? null,
      models: ordered.map((model) => ({
        model: model.slug,
        name: model.name,
        ...describeEfforts(model),
      })),
    };
  });
}

/** Spoken names ("Claude Code") match instance ids, display names, or driver kinds. */
function matchAgent(
  providers: ReadonlyArray<ServerProvider>,
  query: string,
): Result.Result<ServerProvider, string> {
  const wanted = normalize(query);
  const names = (provider: ServerProvider) =>
    [provider.instanceId, provider.displayName, provider.driver]
      .filter((name) => name !== undefined)
      .map(normalize)
      .filter((name) => name.length > 0);
  const exact = providers.filter((provider) => names(provider).includes(wanted));
  const byInstanceId = exact.filter((provider) => normalize(provider.instanceId) === wanted);
  const loose = providers.filter((provider) =>
    names(provider).some((name) => name.startsWith(wanted) || wanted.startsWith(name)),
  );
  for (const candidates of [byInstanceId, exact, loose]) {
    if (candidates.length === 1) return Result.succeed(candidates[0]!);
    if (candidates.length > 1) {
      return Result.fail(
        `"${query}" matches several agents: ${candidates.map(agentLabel).join(", ")}. Pass one agent id.`,
      );
    }
  }
  return Result.fail(
    `No agent matches "${query}". Available agents: ${providers.map(agentLabel).join(", ")}.`,
  );
}

/** Exact slug, name, or alias first; otherwise one unambiguous partial match ("opus"). */
function matchModel(provider: ServerProvider, query: string): string | null {
  const exact = resolveSelectableModel(provider.driver, query, provider.models);
  if (exact !== null) return exact;
  const wanted = normalize(query);
  if (wanted.length === 0) return null;
  const partial = provider.models.filter((model) =>
    [model.slug, model.name, model.shortName]
      .filter((name) => name !== undefined)
      .some((name) => normalize(name).includes(wanted)),
  );
  const current = partial.filter((model) => model.isLegacy !== true);
  for (const candidates of [partial, current, current.filter((model) => model.isDefault)]) {
    if (candidates.length === 1) return candidates[0]!.slug;
  }
  return null;
}

function modelList(provider: ServerProvider) {
  return provider.models
    .filter((model) => model.isLegacy !== true)
    .map((model) => model.slug)
    .join(", ");
}

/**
 * Picks the agent and model for a new session the way a new thread in the UI
 * would: the explicit request, then the project's default, then the first
 * ready agent's default model.
 */
export function resolveModelSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectDefault: ModelSelection | null;
  readonly agent?: string | undefined;
  readonly model?: string | undefined;
}): Result.Result<ModelSelection, string> {
  const selectable = input.providers.filter(isSelectable);
  if (selectable.length === 0) {
    return Result.fail("No agent is enabled and installed on this server.");
  }
  const projectProvider = selectable.find(
    (provider) => provider.instanceId === input.projectDefault?.instanceId,
  );
  const readyFirst = [
    ...(projectProvider === undefined ? [] : [projectProvider]),
    ...selectable.filter((provider) => provider !== projectProvider && provider.status === "ready"),
    ...selectable.filter((provider) => provider !== projectProvider && provider.status !== "ready"),
  ];

  let provider: ServerProvider;
  if (input.agent !== undefined) {
    const matched = matchAgent(selectable, input.agent);
    if (Result.isFailure(matched)) return Result.fail(matched.failure);
    provider = matched.success;
  } else if (input.model !== undefined) {
    const model = input.model;
    const owner = readyFirst.find((candidate) => matchModel(candidate, model) !== null);
    if (owner === undefined) {
      return Result.fail(
        `No agent on this server has a model matching "${model}". Available agents: ${selectable.map(agentLabel).join(", ")}.`,
      );
    }
    provider = owner;
  } else {
    provider = readyFirst[0]!;
  }

  const projectDefault =
    input.projectDefault?.instanceId === provider.instanceId ? input.projectDefault : null;
  if (input.model !== undefined) {
    const slug = matchModel(provider, input.model);
    if (slug === null) {
      return Result.fail(
        `Agent "${provider.instanceId}" has no model matching "${input.model}". Its models: ${modelList(provider)}.`,
      );
    }
    // The project default may carry option selections (reasoning effort) for this model.
    return Result.succeed(
      projectDefault?.model === slug
        ? projectDefault
        : { instanceId: provider.instanceId, model: slug },
    );
  }
  if (projectDefault !== null) return Result.succeed(projectDefault);
  const fallback = defaultModel(provider);
  return fallback === undefined
    ? Result.fail(`Agent "${provider.instanceId}" reports no models.`)
    : Result.succeed({ instanceId: provider.instanceId, model: fallback.slug });
}

/**
 * A model's reasoning effort choices. `unknown` means the server sent no
 * capability metadata for the model, not that it lacks an effort setting.
 */
function reasoningEffortOptions(model: ServerProviderModel | undefined):
  | { readonly support: "unknown" }
  | { readonly support: "not_configurable" }
  | {
      readonly support: "configurable";
      readonly descriptor: SelectProviderOptionDescriptor;
      readonly choices: SelectProviderOptionDescriptor["options"];
    } {
  if (model?.capabilities == null) return { support: "unknown" };
  const descriptor = model.capabilities.optionDescriptors?.find(
    (candidate): candidate is SelectProviderOptionDescriptor =>
      candidate.type === "select" && REASONING_EFFORT_OPTION_IDS.has(candidate.id),
  );
  // Prompt-injected values (Claude's ultrathink) are written into the
  // message by the composer; sent as an option they fall back to the default.
  const choices =
    descriptor?.options.filter((option) => !descriptor.promptInjectedValues?.includes(option.id)) ??
    [];
  return descriptor === undefined || choices.length === 0
    ? { support: "not_configurable" }
    : { support: "configurable", descriptor, choices };
}

const modelLabel = (selection: ModelSelection) =>
  `Model "${selection.model}" on agent "${selection.instanceId}"`;

const findModel = (providers: ReadonlyArray<ServerProvider>, selection: ModelSelection) =>
  providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((model) => model.slug === selection.model);

/** What create_session's reasoning_effort accepts for one model. */
function describeEfforts(model: ServerProviderModel) {
  const efforts = reasoningEffortOptions(model);
  const choices = efforts.support === "configurable" ? efforts.choices : [];
  const fallback =
    efforts.support === "configurable"
      ? getProviderOptionCurrentValue(efforts.descriptor)
      : undefined;
  return {
    reasoning_effort_support: efforts.support,
    reasoning_efforts: choices.map((choice) => ({
      value: choice.id,
      name: choice.label,
      ...(choice.description === undefined ? {} : { description: choice.description }),
    })),
    default_reasoning_effort: choices.find((choice) => choice.id === fallback)?.id ?? null,
  };
}

/**
 * Sets a requested reasoning effort on a resolved selection, keeping its
 * other options. Values match exactly, then by spoken form ("Extra High",
 * "x-high"), and never fall back to a different level.
 */
export function applyReasoningEffort(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection;
  readonly reasoningEffort: string;
}): Result.Result<ModelSelection, string> {
  const { selection, reasoningEffort } = input;
  const efforts = reasoningEffortOptions(findModel(input.providers, selection));
  if (efforts.support === "unknown") {
    return Result.fail(
      `${modelLabel(selection)} does not report its reasoning effort options, so reasoning_effort cannot be applied. Omit reasoning_effort to use the model's default.`,
    );
  }
  if (efforts.support === "not_configurable") {
    return Result.fail(
      `${modelLabel(selection)} has no configurable reasoning effort. Omit reasoning_effort.`,
    );
  }
  const wanted = normalize(reasoningEffort);
  const spoken = efforts.choices.filter(
    (choice) => normalize(choice.id) === wanted || normalize(choice.label) === wanted,
  );
  const choice =
    efforts.choices.find((candidate) => candidate.id === reasoningEffort) ??
    (spoken.length === 1 ? spoken[0] : undefined);
  if (choice === undefined) {
    return Result.fail(
      `${modelLabel(selection)} does not support reasoning effort "${reasoningEffort}". Supported values: ${efforts.choices.map((candidate) => candidate.id).join(", ")}.`,
    );
  }
  const id = efforts.descriptor.id;
  const others = (selection.options ?? []).filter((option) => option.id !== id);
  return Result.succeed({ ...selection, options: [...others, { id, value: choice.id }] });
}

/** The effort a session's model selection carries; null when it uses the model's default. */
export function selectedReasoningEffort(selection: ModelSelection): string | null {
  const option = selection.options?.find((candidate) =>
    REASONING_EFFORT_OPTION_IDS.has(candidate.id),
  );
  return typeof option?.value === "string" ? option.value : null;
}
