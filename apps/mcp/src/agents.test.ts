import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  applyReasoningEffort,
  describeModelCapabilities,
  resolveModelSelection,
  selectedReasoningEffort,
  summarizeAgents,
} from "./agents.ts";

const model = (slug: string, name: string, extra: Partial<ServerProviderModel> = {}) =>
  ({ slug, name, isCustom: false, capabilities: null, ...extra }) satisfies ServerProviderModel;

function provider(id: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(id),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-28T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const codex = provider("codex", {
  displayName: "Codex",
  models: [model("gpt-5.5", "GPT-5.5", { isDefault: true }), model("gpt-5.4-mini", "GPT-5.4 Mini")],
});
const claude = provider("claudeAgent", {
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  models: [
    model("claude-opus-4-1", "Claude Opus 4.1", { isLegacy: true }),
    model("claude-opus-4-6", "Claude Opus 4.6"),
    model("claude-sonnet-4-6", "Claude Sonnet 4.6", { isDefault: true }),
  ],
});
const providers = [codex, claude];

const selection = (instanceId: string, modelSlug: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: modelSlug,
});

const resolve = (input: Omit<Parameters<typeof resolveModelSelection>[0], "providers">) =>
  resolveModelSelection({ providers, ...input });

describe("resolveModelSelection", () => {
  it("keeps the project default, including its options, when nothing is requested", () => {
    const projectDefault = {
      ...selection("claudeAgent", "claude-opus-4-6"),
      options: [{ id: "effort", value: "high" }],
    };
    expect(resolve({ projectDefault })).toEqual(Result.succeed(projectDefault));
  });

  it("falls back to the first ready agent's default model", () => {
    expect(resolve({ projectDefault: null })).toEqual(
      Result.succeed(selection("codex", "gpt-5.5")),
    );
    expect(
      resolveModelSelection({
        providers: [provider("codex", { ...codex, status: "error" }), claude],
        projectDefault: null,
      }),
    ).toEqual(Result.succeed(selection("claudeAgent", "claude-sonnet-4-6")));
  });

  it("matches spoken agent and model names", () => {
    expect(resolve({ projectDefault: null, agent: "Claude Code", model: "opus" })).toEqual(
      Result.succeed(selection("claudeAgent", "claude-opus-4-6")),
    );
    expect(resolve({ projectDefault: null, agent: "codex", model: "GPT-5.4 Mini" })).toEqual(
      Result.succeed(selection("codex", "gpt-5.4-mini")),
    );
  });

  it("uses the requested agent's default model rather than another agent's project default", () => {
    expect(
      resolve({ projectDefault: selection("codex", "gpt-5.4-mini"), agent: "claude" }),
    ).toEqual(Result.succeed(selection("claudeAgent", "claude-sonnet-4-6")));
  });

  it("finds the agent that owns a model when only the model is named", () => {
    expect(resolve({ projectDefault: selection("codex", "gpt-5.5"), model: "sonnet" })).toEqual(
      Result.succeed(selection("claudeAgent", "claude-sonnet-4-6")),
    );
  });

  it("explains an unknown agent or model with the valid choices", () => {
    const agent = resolve({ projectDefault: null, agent: "gemini" });
    expect(Result.isFailure(agent) && agent.failure).toContain("codex (Codex)");
    const unknownModel = resolve({ projectDefault: null, agent: "codex", model: "o9" });
    expect(Result.isFailure(unknownModel) && unknownModel.failure).toContain(
      "gpt-5.5, gpt-5.4-mini",
    );
  });

  it("never selects a disabled agent", () => {
    const result = resolveModelSelection({
      providers: [provider("codex", { ...codex, enabled: false }), claude],
      projectDefault: selection("codex", "gpt-5.5"),
      agent: "codex",
    });
    expect(Result.isFailure(result) && result.failure).toContain("No agent matches");
  });
});

describe("summarizeAgents", () => {
  it("lists the default model first and legacy models last", () => {
    const [summary] = summarizeAgents([claude]);
    expect(summary?.default_model).toBe("claude-sonnet-4-6");
    expect(summary?.models.map((entry) => entry.model)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-1",
    ]);
  });

  it("lists every model so clients can pick any of them", () => {
    const slugs = Array.from({ length: 40 }, (_, index) => `model-${index}`);
    const [summary] = summarizeAgents([
      provider("opencode", { models: slugs.map((slug) => model(slug, slug)) }),
    ]);
    expect(summary?.models.map((entry) => entry.model)).toEqual(slugs);
    expect(summary).not.toHaveProperty("more_models");
  });
});

const levels = (...ids: ReadonlyArray<string>) =>
  ids.map((id) => ({
    id,
    label: id === "xhigh" ? "Extra High" : id[0]!.toUpperCase() + id.slice(1),
  }));
const withOptions = (...optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => ({
  capabilities: { optionDescriptors },
});

/** Option metadata as each driver publishes it, so effort lookup is per model, never per driver. */
const capable = [
  provider("codex", {
    displayName: "Codex",
    models: [
      model("gpt-6-astra", "GPT-6 Astra", {
        isDefault: true,
        ...withOptions(
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: levels("low", "medium", "high", "xhigh"),
            currentValue: "medium",
          },
          {
            id: "serviceTier",
            label: "Service Tier",
            type: "select",
            options: [{ id: "default", label: "Standard", isDefault: true }],
          },
        ),
      }),
      model("gpt-5.5", "GPT-5.5"),
    ],
  }),
  provider("claudeAgent", {
    displayName: "Claude",
    models: [
      model("claude-opus-5-5", "Claude Opus 5.5", {
        isDefault: true,
        ...withOptions(
          {
            id: "contextWindow",
            label: "Context Window",
            type: "select",
            options: [{ id: "1m", label: "1M", isDefault: true }],
          },
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              ...levels("low", "medium"),
              { id: "high", label: "High", isDefault: true },
              {
                id: "ultracode",
                label: "Ultracode",
                description: "xhigh effort plus multi-agent workflow orchestration",
              },
              { id: "ultrathink", label: "Ultrathink" },
            ],
            promptInjectedValues: ["ultrathink"],
          },
        ),
      }),
      model(
        "claude-haiku-4-5",
        "Claude Haiku 4.5",
        withOptions({ id: "thinking", label: "Thinking", type: "boolean" }),
      ),
    ],
  }),
  provider("antigravity", {
    models: [model("antigravity-default", "Default", withOptions())],
  }),
];

const capabilitiesOf = (agent: string | undefined, modelName: string) =>
  describeModelCapabilities({ providers: capable, agent, model: modelName });
const effortOf = (selection: ModelSelection, reasoningEffort: string) =>
  applyReasoningEffort({ providers: capable, selection, reasoningEffort });

describe("describeModelCapabilities", () => {
  it("lists a model's efforts and default, resolving spoken names as create_session does", () => {
    expect(capabilitiesOf("Codex", "astra")).toEqual(
      Result.succeed({
        agent: "codex",
        model: "gpt-6-astra",
        name: "GPT-6 Astra",
        reasoning_effort_support: "configurable",
        reasoning_efforts: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
          { value: "xhigh", name: "Extra High" },
        ],
        default_reasoning_effort: "medium",
      }),
    );
  });

  it("finds Claude's effort after other selects and leaves out prompt keywords", () => {
    const described = Result.getOrThrow(capabilitiesOf(undefined, "opus"));
    expect(described).toMatchObject({
      agent: "claudeAgent",
      model: "claude-opus-5-5",
      reasoning_effort_support: "configurable",
      default_reasoning_effort: "high",
    });
    expect(described.reasoning_efforts).toEqual([
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      {
        value: "ultracode",
        name: "Ultracode",
        description: "xhigh effort plus multi-agent workflow orchestration",
      },
    ]);
  });

  it("separates models without an effort setting from models without metadata", () => {
    for (const [agent, name] of [
      ["claude", "haiku"],
      ["antigravity", "default"],
    ] as const) {
      expect(Result.getOrThrow(capabilitiesOf(agent, name))).toMatchObject({
        reasoning_effort_support: "not_configurable",
        reasoning_efforts: [],
        default_reasoning_effort: null,
      });
    }
    expect(Result.getOrThrow(capabilitiesOf("codex", "gpt-5.5"))).toMatchObject({
      reasoning_effort_support: "unknown",
      reasoning_efforts: [],
      default_reasoning_effort: null,
    });
  });

  it("explains an unknown model with the agent's models", () => {
    const unknown = capabilitiesOf("codex", "o9");
    expect(Result.isFailure(unknown) && unknown.failure).toContain("gpt-6-astra, gpt-5.5");
  });
});

describe("applyReasoningEffort", () => {
  it("sets the driver's own option id and keeps the selection's other options", () => {
    const projectDefault = {
      ...selection("codex", "gpt-6-astra"),
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "serviceTier", value: "fast" },
      ],
    };
    expect(effortOf(projectDefault, "high")).toEqual(
      Result.succeed({
        ...projectDefault,
        options: [
          { id: "serviceTier", value: "fast" },
          { id: "reasoningEffort", value: "high" },
        ],
      }),
    );
    expect(effortOf(selection("claudeAgent", "claude-opus-5-5"), "ultracode")).toEqual(
      Result.succeed({
        ...selection("claudeAgent", "claude-opus-5-5"),
        options: [{ id: "effort", value: "ultracode" }],
      }),
    );
  });

  it("accepts spoken forms of a supported level", () => {
    for (const spoken of ["Extra High", "x-high", "XHIGH"]) {
      expect(effortOf(selection("codex", "gpt-6-astra"), spoken)).toEqual(
        Result.succeed({
          ...selection("codex", "gpt-6-astra"),
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        }),
      );
    }
  });

  it("rejects unsupported levels, prompt keywords, and models it cannot check", () => {
    const failure = (result: Result.Result<ModelSelection, string>) =>
      Result.isFailure(result) ? result.failure : null;
    expect(failure(effortOf(selection("codex", "gpt-6-astra"), "max"))).toBe(
      'Model "gpt-6-astra" on agent "codex" does not support reasoning effort "max". Supported values: low, medium, high, xhigh.',
    );
    expect(failure(effortOf(selection("claudeAgent", "claude-opus-5-5"), "ultrathink"))).toContain(
      "Supported values: low, medium, high, ultracode.",
    );
    expect(failure(effortOf(selection("claudeAgent", "claude-haiku-4-5"), "high"))).toContain(
      "has no configurable reasoning effort",
    );
    expect(failure(effortOf(selection("codex", "gpt-5.5"), "high"))).toContain(
      "does not report its reasoning effort options",
    );
  });
});

describe("selectedReasoningEffort", () => {
  it("reads the effort under any driver's option id, or null for the model default", () => {
    expect(
      selectedReasoningEffort({
        ...selection("claudeAgent", "claude-opus-5-5"),
        options: [
          { id: "fastMode", value: true },
          { id: "effort", value: "max" },
        ],
      }),
    ).toBe("max");
    expect(
      selectedReasoningEffort({
        ...selection("opencode", "openai/gpt-5"),
        options: [{ id: "variant", value: "high" }],
      }),
    ).toBe("high");
    expect(selectedReasoningEffort(selection("codex", "gpt-6-astra"))).toBeNull();
  });
});
