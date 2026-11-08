import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ManagedPolicy from "../../../server/src/policy/ManagedPolicy.ts";
import { makeManagedProviders } from "../../../server/src/policy/managedProviders.ts";
import { sourceControlDefinitions } from "../../../server/src/sourceControl/sourceControlDefinitions.ts";
import { sourceControlDefinitions as shimmedDefinitions } from "../shims/sourceControlDefinitions.ts";
import { BUILT_IN_SETTINGS, HIDDEN_SETTINGS, SETTING_ROWS } from "./catalog.ts";
import { parsePolicyText, serializePolicy } from "./document.ts";
import { KNOWN_DRIVERS } from "./drivers.ts";
import { getPath, setPath } from "./json.ts";
import { SETTINGS_COPY } from "./settingsCopy.ts";
import { type ProblemTarget, validatePolicy } from "./validate.ts";

/** The policy deimos and mudd run, as deployed. */
const DEIMOS_POLICY = `{"schemaVersion":1,"organization":"dotfiles","limits":{"telemetry":false},"settings":{"linkedEnvironmentsEnabled":{"value":true,"locked":true},"enableProviderUpdateChecks":{"value":false,"locked":true},"storageCleanup.worktreeAfterDays":{"value":8,"locked":false},"storageCleanup.worktreeOnMerge":{"value":true,"locked":false},"storageCleanup.worktreeOnDelete":{"value":true,"locked":false},"storageCleanup.worktreeUnchanged":{"value":true,"locked":false},"storageCleanup.browserArtifactsAfterDays":{"value":8,"locked":false},"storageCleanup.logsAfterDays":{"value":8,"locked":false},"defaultAutoPull":{"value":true,"locked":false},"idleCompaction":{"value":"beforeCacheExpires","locked":false},"snoozeLimitedThreads":{"value":true,"locked":false},"autoResumeLimitedThreads":{"value":true,"locked":false},"sidebarAutoSettleOnMerge":{"value":false,"locked":false},"branchNamingMode":{"value":"semantic","locked":false},"branchNamePrefix":{"value":"whexy/","locked":false},"pullRequestMergeMethod":{"value":"rebase","locked":false}}}`;

const policy = (extra: Record<string, unknown>) => ({
  schemaVersion: 1,
  organization: "Example Corp",
  ...extra,
});
const setting = (key: string, value: unknown, locked: boolean) =>
  policy({ settings: { [key]: { value, locked } } });
const lock = (key: string, value: unknown) => setting(key, value, true);
const preset = (key: string, value: unknown) => setting(key, value, false);
const limits = (value: Record<string, unknown>) => policy({ limits: value });

type Expectation =
  | { readonly verdict: "valid" }
  | { readonly verdict: "invalid"; readonly at: ProblemTarget }
  /** `t3 policy check` accepts these; the editor refuses keys that are not a user's choice. */
  | { readonly verdict: "editor-only"; readonly at: ProblemTarget };

const valid = { verdict: "valid" } as const;
const at = (target: ProblemTarget) => ({ verdict: "invalid", at: target }) as const;
const atSetting = (key: string) => at({ kind: "setting", key });
const editorOnly = (key: string) =>
  ({ verdict: "editor-only", at: { kind: "setting", key } }) as const;

const FIXTURES: ReadonlyArray<readonly [name: string, document: unknown, expect: Expectation]> = [
  ["the deimos policy", JSON.parse(DEIMOS_POLICY), valid],
  [
    "the documented example",
    policy({
      supportUrl: "https://it.example.com/t3",
      settings: {
        defaultRuntimeMode: { value: "approval-required", locked: false },
        enableAgentBrowserAccess: { value: false, locked: true },
      },
      limits: {
        maxRuntimeMode: "auto-accept-edits",
        clients: ["desktop", "local-browser"],
        telemetry: false,
      },
    }),
    valid,
  ],
  [
    "the documented limits example",
    limits({
      maxRuntimeMode: "auto-accept-edits",
      clients: ["desktop"],
      connect: false,
      webhookTasks: false,
      browserCookieImport: false,
      telemetry: false,
      providers: {
        allowedDrivers: ["claudeAgent", "codex"],
        instances: {
          claudeAgent: {
            locked: true,
            environment: [{ name: "CLAUDE_CODE_USE_BEDROCK", value: "1" }],
          },
        },
      },
      updates: { mode: "auto", feedUrl: "https://updates.example.com/t3code/" },
    }),
    valid,
  ],
  ["an unknown setting", preset("notASetting", true), atSetting("notASetting")],
  [
    "projectSettingsOverrides",
    lock("projectSettingsOverrides", {}),
    atSetting("projectSettingsOverrides"),
  ],
  [
    "projectAgentBrowserAccessOverrides",
    lock("projectAgentBrowserAccessOverrides", {}),
    atSetting("projectAgentBrowserAccessOverrides"),
  ],
  [
    "projectAutoPullOverrides",
    lock("projectAutoPullOverrides", {}),
    atSetting("projectAutoPullOverrides"),
  ],
  [
    "projectScriptOverrides",
    lock("projectScriptOverrides", {}),
    atSetting("projectScriptOverrides"),
  ],
  [
    "compactIdleThreads, which follows idleCompaction",
    lock("compactIdleThreads", true),
    atSetting("compactIdleThreads"),
  ],
  [
    "a default that adds model aliases",
    preset("usageModelAliases", { fast: "gpt-5" }),
    atSetting("usageModelAliases"),
  ],
  [
    "a default that adds a price override",
    preset("usagePriceOverrides.gpt-5", {
      inputCostPerMillionTokens: 1,
      outputCostPerMillionTokens: 2,
    }),
    atSetting("usagePriceOverrides.gpt-5"),
  ],
  ["a locked model alias", lock("usageModelAliases.fast", "gpt-5"), valid],
  [
    "a path inside a nullable setting",
    lock("defaultModelSelection.model", "gpt-5"),
    atSetting("defaultModelSelection.model"),
  ],
  [
    "a lock on one field of a provider instance",
    lock("providerInstances.codex.enabled", false),
    atSetting("providerInstances.codex.enabled"),
  ],
  [
    "a lock on a whole provider instance",
    lock("providerInstances.codex", { driver: "codex", enabled: false }),
    valid,
  ],
  [
    "a worktree rule locked without worktreeCleanup",
    lock("storageCleanup.worktreeAfterDays", 3),
    atSetting("storageCleanup.worktreeAfterDays"),
  ],
  [
    "a worktree rule locked with worktreeCleanup",
    policy({
      settings: {
        "storageCleanup.worktreeAfterDays": { value: 3, locked: true },
        worktreeCleanup: { value: null, locked: true },
      },
    }),
    valid,
  ],
  [
    "a default runtime mode above the ceiling",
    policy({
      settings: { defaultRuntimeMode: { value: "full-access", locked: false } },
      limits: { maxRuntimeMode: "auto-accept-edits" },
    }),
    atSetting("defaultRuntimeMode"),
  ],
  [
    "a credential in a setting",
    lock("providerInstances.claude2", {
      driver: "claudeAgent",
      environment: [{ name: "ANTHROPIC_API_KEY", value: "sk-test", sensitive: true }],
    }),
    atSetting("providerInstances.claude2"),
  ],
  [
    "a value of the wrong type",
    lock("enableAgentBrowserAccess", "yes"),
    atSetting("enableAgentBrowserAccess"),
  ],
  [
    "a setting without locked",
    policy({ settings: { defaultAutoPull: { value: true } } }),
    atSetting("defaultAutoPull"),
  ],
  [
    "a setting with an extra key",
    policy({ settings: { defaultAutoPull: { value: true, locked: false, note: "x" } } }),
    atSetting("defaultAutoPull"),
  ],
  [
    "a missing organization",
    { schemaVersion: 1, settings: {} },
    at({ kind: "document", key: "organization" }),
  ],
  [
    "another schema version",
    { ...policy({}), schemaVersion: 2 },
    at({ kind: "document", key: "schemaVersion" }),
  ],
  [
    "an empty support URL",
    policy({ supportUrl: " " }),
    at({ kind: "document", key: "supportUrl" }),
  ],
  ["an unknown top-level key", policy({ extra: true }), at({ kind: "document", key: "extra" })],
  ["an unknown limit", limits({ sandbox: true }), at({ kind: "limit", key: "sandbox" })],
  [
    "an unknown runtime mode",
    limits({ maxRuntimeMode: "yolo" }),
    at({ kind: "limit", key: "maxRuntimeMode" }),
  ],
  ["no clients", limits({ clients: [] }), at({ kind: "limit", key: "clients" })],
  [
    "an update feed over http",
    limits({ updates: { mode: "auto", feedUrl: "http://updates.example.com/" } }),
    at({ kind: "limit", key: "updates" }),
  ],
  [
    "an unknown allowed driver",
    limits({ providers: { allowedDrivers: ["nope"] } }),
    at({ kind: "limit", key: "providers.allowedDrivers" }),
  ],
  [
    "a pinned field the provider lacks",
    limits({ providers: { instances: { acpRegistry: { locked: true, binaryPath: "/bin/acp" } } } }),
    at({ kind: "limit", key: "providers.instances", entry: "acpRegistry" }),
  ],
  [
    "a pinned variable named twice",
    limits({
      providers: {
        instances: {
          codex: {
            locked: true,
            environment: [
              { name: "OPENAI_BASE_URL", value: "a" },
              { name: "OPENAI_BASE_URL", value: "b" },
            ],
          },
        },
      },
    }),
    at({ kind: "limit", key: "providers.instances", entry: "codex" }),
  ],
  [
    "pinned variables that differ only in case",
    limits({
      providers: {
        instances: {
          codex: {
            locked: true,
            environment: [
              { name: "OPENAI_BASE_URL", value: "a" },
              { name: "openai_base_url", value: "b" },
            ],
          },
        },
      },
    }),
    valid,
  ],
  ["server state", preset("projectSettingsFolded", true), editorOnly("projectSettingsFolded")],
  [
    "a legacy setting",
    preset("automaticGitFetchInterval", 60_000),
    editorOnly("automaticGitFetchInterval"),
  ],
  [
    "a format version",
    lock("backgroundActivity.schemaVersion", 1),
    editorOnly("backgroundActivity.schemaVersion"),
  ],
  [
    "a field-by-field setting as a whole",
    preset("storageCleanup", {
      ...(getPath(BUILT_IN_SETTINGS, ["storageCleanup"]) as object),
      logsAfterDays: 8,
    }),
    editorOnly("storageCleanup"),
  ],
  [
    "one field of a setting the editor manages whole",
    lock("textGenerationModelSelection.model", "gpt-5"),
    editorOnly("textGenerationModelSelection.model"),
  ],
];

const sameTarget = (left: ProblemTarget, right: ProblemTarget) =>
  JSON.stringify(left) === JSON.stringify(right);

it.layer(NodeServices.layer)("policy editor validation", (it) => {
  /** What `t3 policy check` says about `document`: undefined when it accepts it, else its reason. */
  const policyCheck = (document: unknown) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-policy-editor-" });
      const file = path.join(dir, "policy.json");
      yield* fs.writeFileString(file, JSON.stringify(document));
      return yield* ManagedPolicy.load(file).pipe(
        Effect.match({ onFailure: (error) => error.reason, onSuccess: () => undefined }),
      );
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux"));

  it.effect.each(FIXTURES.map(([name, document, expect]) => ({ name, document, expect })))(
    "agrees with t3 policy check on $name",
    ({ document, expect }) =>
      Effect.gen(function* () {
        const server = yield* policyCheck(document);
        const editor = validatePolicy(document);
        assert.strictEqual(server === undefined, expect.verdict !== "invalid", `server: ${server}`);
        assert.strictEqual(
          editor.valid,
          expect.verdict === "valid",
          JSON.stringify(editor.problems),
        );
        assert.strictEqual(editor.serverReason === undefined, server === undefined);
        if (expect.verdict === "valid") return;
        const errors = editor.problems.filter((problem) => problem.severity === "error");
        assert.isTrue(
          errors.some((problem) => sameTarget(problem.target, expect.at)),
          `expected a problem at ${JSON.stringify(expect.at)}, got ${JSON.stringify(errors)}`,
        );
        // Where the server names its reason, the editor shows the same words.
        if (server !== undefined && !server.startsWith("it is not valid JSON")) {
          assert.isTrue(
            errors.some((problem) => problem.message.includes(server)),
            server,
          );
        }
      }),
  );

  it.effect("shows every refused setting at once, each beside its own key", () =>
    Effect.sync(() => {
      const editor = validatePolicy(
        policy({
          settings: {
            enableAgentBrowserAccess: { value: "yes", locked: true },
            "providerInstances.codex.enabled": { value: false, locked: true },
            compactIdleThreads: { value: true, locked: false },
            defaultAutoPull: { value: true, locked: false },
          },
        }),
      );
      assert.deepEqual(
        editor.problems.map((problem) => problem.target),
        [
          { kind: "setting", key: "compactIdleThreads" },
          { kind: "setting", key: "providerInstances.codex.enabled" },
          { kind: "setting", key: "enableAgentBrowserAccess" },
        ],
      );
      assert.include(editor.problems[2]?.detail ?? "", "Expected boolean");
    }),
  );

  it.effect("warns, without refusing, about variables only Windows reads as one", () =>
    Effect.sync(() => {
      const editor = validatePolicy(
        limits({
          providers: {
            instances: {
              codex: {
                locked: true,
                environment: [
                  { name: "A", value: "1" },
                  { name: "a", value: "2" },
                ],
              },
            },
          },
        }),
      );
      assert.deepEqual(
        editor.problems.map((problem) => [problem.severity, problem.target]),
        [["warning", { kind: "limit", key: "providers.instances", entry: "codex" }]],
      );
    }),
  );
});

describe("policy files", () => {
  it("saves an opened policy unchanged as the same bytes", () => {
    for (const text of [DEIMOS_POLICY, `${JSON.stringify(JSON.parse(DEIMOS_POLICY), null, 2)}\n`]) {
      const parsed = parsePolicyText(text);
      assert.isTrue(parsed.ok);
      if (!parsed.ok) return;
      const opened = { text, document: parsed.document };
      assert.strictEqual(serializePolicy(structuredClone(parsed.document), opened), text);
      // An edit that is undone leaves the file as it was.
      const edited = setPath(parsed.document, ["settings", "defaultAutoPull"], undefined);
      const undone = setPath(edited, ["settings", "defaultAutoPull"], {
        value: true,
        locked: false,
      });
      assert.notStrictEqual(serializePolicy(edited, opened), text);
      assert.strictEqual(serializePolicy(structuredClone(undone), opened), text);
    }
  });

  it("keeps the file's layout and key order when one setting changes", () => {
    const parsed = parsePolicyText(DEIMOS_POLICY);
    if (!parsed.ok) throw new Error(parsed.message);
    const edited = setPath(parsed.document, ["settings", "branchNamePrefix"], {
      value: "t3/",
      locked: false,
    });
    assert.strictEqual(
      serializePolicy(edited, { text: DEIMOS_POLICY, document: parsed.document }),
      DEIMOS_POLICY.replace('"whexy/"', '"t3/"'),
    );
  });
});

describe("settings catalog", () => {
  it("names only settings the schema has", () => {
    const fields = new Set(Object.keys(ServerSettings.fields));
    for (const path of [...HIDDEN_SETTINGS.keys(), ...SETTINGS_COPY.map((copy) => copy.path)]) {
      assert.isTrue(fields.has(path.split(".")[0] ?? ""), `${path} is not in ServerSettings`);
    }
  });

  it("shows every setting the Settings page edits", () => {
    for (const copy of SETTINGS_COPY) assert.isTrue(SETTING_ROWS.has(copy.path), copy.path);
  });

  it("offers the Settings page's choices for a setting that takes any string", () => {
    for (const path of ["speechModelId", "speechAcceleration"]) {
      const row = SETTING_ROWS.get(path);
      assert.strictEqual(row?.control.kind, "select", path);
      if (row?.control.kind !== "select") continue;
      const values = row.control.options.map((option) => option.value);
      assert.include(values, row.builtIn, `${path} does not offer its built-in default`);
    }
  });

  it("offers the drivers, and the fields per driver, the server accepts", () => {
    for (const driver of KNOWN_DRIVERS) {
      const accepts = (pin: Record<string, string>) =>
        makeManagedProviders(
          {
            allowedDrivers: [driver.id],
            instances: Object.fromEntries([[driver.id, { locked: true, ...pin }]]),
          },
          undefined,
          "linux",
        )._tag === "Valid";
      assert.isTrue(accepts({}), driver.id);
      assert.strictEqual(accepts({ binaryPath: "/bin/x" }), driver.binaryPath, driver.id);
      assert.strictEqual(accepts({ launchArgs: "--x" }), driver.launchArgs, driver.id);
    }
  });

  it("runs the server's own source control registry", () => {
    assert.strictEqual(shimmedDefinitions, sourceControlDefinitions);
  });
});
