import { PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";

import { KNOWN_DRIVERS } from "../policy/drivers.ts";
import { isRecord } from "../policy/json.ts";
import { SETTINGS_COPY } from "../policy/settingsCopy.ts";
import type { Problem } from "../policy/validate.ts";
import { ProblemList, StateToggle } from "./controls.tsx";
import { SettingsRow, SettingsSection } from "./settingsLayout.tsx";

export type SetLimit = (segments: ReadonlyArray<string>, value: unknown) => void;
export type LimitProblems = (key: string, entry?: string) => ReadonlyArray<Problem>;

export const limitAnchor = (key: string, entry?: string) =>
  `limit:${key}${entry === undefined ? "" : `:${entry}`}`;

const RUNTIME_MODES =
  SETTINGS_COPY.find((copy) => copy.path === "defaultRuntimeMode")?.options ?? [];

const CLIENTS = [
  { id: "desktop", label: "Desktop app", description: "As the desktop app's own server." },
  {
    id: "local-browser",
    label: "Browsers on this machine",
    description: "As a server only browsers on this machine reach, such as npx t3.",
  },
  {
    id: "remote",
    label: "Remote",
    description: "Reachable from phones, other computers, and app.t3.codes over the network.",
  },
] as const;

const CAPABILITIES = [
  {
    key: "connect",
    title: "T3 Connect",
    description:
      "Off turns T3 Connect off while other remote access stays. Leaving remote out of clients turns it off too.",
  },
  {
    key: "webhookTasks",
    title: "Webhook tasks",
    description:
      "Off: scheduled tasks cannot use webhook triggers. Existing webhook tasks stay but do not run.",
  },
  {
    key: "browserCookieImport",
    title: "Browser cookie import",
    description: "Off: users cannot import cookies from another browser into T3 Code's browser.",
  },
  {
    key: "telemetry",
    title: "Telemetry",
    description:
      "Off: the server and desktop app send no product usage data or relay connection traces. A policy cannot turn them on.",
  },
] as const;

type Tri = "unset" | "allow" | "deny";
const triOf = (value: unknown): Tri =>
  value === undefined ? "unset" : value === false ? "deny" : "allow";
const TRI_LABELS = { unset: "Not set", allow: "Allowed", deny: "Off" } as const;

function CheckList({
  items,
  selected,
  onChange,
}: {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }>;
  readonly selected: ReadonlyArray<unknown>;
  readonly onChange: (selected: ReadonlyArray<string>) => void;
}) {
  // Keep values the file names that the list does not know, so they can be seen and removed.
  const unknown = selected.filter(
    (value): value is string =>
      typeof value === "string" && !items.some((item) => item.id === value),
  );
  const all = [
    ...items,
    ...unknown.map((id) => ({ id, label: id, description: "Not a known value" })),
  ];
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {all.map((item) => {
        const checked = selected.includes(item.id);
        return (
          <label key={item.id} className="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox
              checked={checked}
              onCheckedChange={(next) => {
                const ids = selected.filter((value): value is string => typeof value === "string");
                onChange(next ? [...ids, item.id] : ids.filter((id) => id !== item.id));
              }}
            />
            <span className="min-w-0">
              <span className="block leading-4">{item.label}</span>
              <span className="block text-xs text-ink-muted">
                <code>{item.id}</code>
                {item.description ? ` · ${item.description}` : ""}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function OptionalText({
  label,
  value,
  placeholder,
  onChange,
}: {
  readonly label: string;
  readonly value: unknown;
  readonly placeholder: string;
  readonly onChange: (value: string | undefined) => void;
}) {
  return (
    <label className="block space-y-1 text-xs text-ink-muted">
      <span>{label}</span>
      <Input
        size="sm"
        spellCheck={false}
        autoCapitalize="none"
        placeholder={placeholder}
        value={typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)}
        onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
      />
    </label>
  );
}

function ProviderPin({
  driverId,
  pin,
  problems,
  setLimit,
}: {
  readonly driverId: string;
  readonly pin: unknown;
  readonly problems: ReadonlyArray<Problem>;
  readonly setLimit: SetLimit;
}) {
  const known = KNOWN_DRIVERS.find((driver) => driver.id === driverId);
  const at = (...segments: string[]) => ["providers", "instances", driverId, ...segments];
  const fields = isRecord(pin) ? pin : {};
  const environment = Array.isArray(fields.environment) ? fields.environment : [];
  const setEnvironment = (next: ReadonlyArray<unknown>) =>
    setLimit(at("environment"), next.length === 0 ? undefined : next);
  return (
    <div
      id={limitAnchor("providers.instances", driverId)}
      className="scroll-mt-20 space-y-3 rounded-xl border border-black/5 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">
          {known?.label ?? driverId} <code className="text-xs text-ink-muted">{driverId}</code>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            Locked
            <Switch
              size="sm"
              checked={fields.locked === true}
              onCheckedChange={(checked) => setLimit(at("locked"), checked)}
            />
          </label>
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            aria-label={`Remove ${driverId}`}
            onClick={() => setLimit(at(), undefined)}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
      <p className="text-xs text-ink-muted">
        {fields.locked === true
          ? "Users cannot change the fields set here."
          : "The fields set here fill in only what the user left empty."}
      </p>
      {known === undefined || known.binaryPath || fields.binaryPath !== undefined ? (
        <OptionalText
          label="Binary path"
          placeholder="Not pinned"
          value={fields.binaryPath}
          onChange={(value) => setLimit(at("binaryPath"), value)}
        />
      ) : null}
      {known === undefined || known.launchArgs || fields.launchArgs !== undefined ? (
        <OptionalText
          label="Launch arguments"
          placeholder="Not pinned"
          value={fields.launchArgs}
          onChange={(value) => setLimit(at("launchArgs"), value)}
        />
      ) : null}
      <div className="space-y-1.5">
        <div className="text-xs text-ink-muted">Environment variables</div>
        {environment.map((variable, index) => {
          const record = isRecord(variable) ? variable : {};
          const update = (key: "name" | "value", text: string) =>
            setEnvironment(
              environment.map((item, position) =>
                position === index ? { ...record, [key]: text } : item,
              ),
            );
          return (
            // oxlint-disable-next-line react/no-array-index-key -- variables have no identity but their row; each input is controlled
            <div key={index} className="flex items-center gap-2">
              <Input
                size="sm"
                font="mono"
                aria-label="Variable name"
                placeholder="NAME"
                spellCheck={false}
                value={typeof record.name === "string" ? record.name : ""}
                onChange={(event) => update("name", event.target.value)}
              />
              <Input
                size="sm"
                font="mono"
                aria-label="Variable value"
                placeholder="value"
                spellCheck={false}
                value={typeof record.value === "string" ? record.value : ""}
                onChange={(event) => update("value", event.target.value)}
              />
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                aria-label="Remove variable"
                onClick={() =>
                  setEnvironment(environment.filter((_, position) => position !== index))
                }
              >
                <Trash2Icon />
              </Button>
            </div>
          );
        })}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEnvironment([...environment, { name: "", value: "" }])}
        >
          <PlusIcon />
          Add variable
        </Button>
      </div>
      <ProblemList problems={problems} />
    </div>
  );
}

export function LimitsSection({
  limits: rawLimits,
  setLimit,
  problemsFor,
}: {
  readonly limits: unknown;
  readonly setLimit: SetLimit;
  readonly problemsFor: LimitProblems;
}) {
  const limits = isRecord(rawLimits) ? rawLimits : {};
  const providers = isRecord(limits.providers) ? limits.providers : {};
  const instances = isRecord(providers.instances) ? providers.instances : {};
  const updates = isRecord(limits.updates) ? limits.updates : undefined;
  const invalid = (key: string) => problemsFor(key).some((problem) => problem.severity === "error");
  const runtimeOptions = [{ value: null, label: "Not set" }, ...RUNTIME_MODES];
  const unknownKeys = Object.keys(limits).filter(
    (key) =>
      ![
        "maxRuntimeMode",
        "clients",
        "providers",
        "updates",
        ...CAPABILITIES.map((item) => item.key),
      ].includes(key),
  );
  const unaddedDrivers = KNOWN_DRIVERS.filter((driver) => !(driver.id in instances));

  return (
    <SettingsSection
      id="section:limits"
      title="Limits"
      description="Restrictions that are not settings: users cannot opt out of them anywhere. Leave a key out to keep T3 Code's normal behavior."
    >
      <SettingsRow
        id={limitAnchor("maxRuntimeMode")}
        invalid={invalid("maxRuntimeMode")}
        title="Broadest permission mode"
        description="Covers threads that users, agents, and scheduled tasks start. With it set, you own each provider's launch settings: binary path, launch arguments, config home, and environment variables."
        status={<code className="font-mono text-xs text-ink-muted">limits.maxRuntimeMode</code>}
        control={
          <Select
            value={limits.maxRuntimeMode === undefined ? "unset" : String(limits.maxRuntimeMode)}
            onValueChange={(mode) => {
              if (mode !== null) setLimit(["maxRuntimeMode"], mode === "unset" ? undefined : mode);
            }}
          >
            <SelectTrigger size="sm" aria-label="Broadest permission mode">
              <SelectValue>
                {(mode: string) =>
                  runtimeOptions.find((option) => (option.value ?? "unset") === mode)?.label ?? mode
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {runtimeOptions.map((option) => (
                <SelectItem key={option.value ?? "unset"} value={option.value ?? "unset"}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        <ProblemList problems={problemsFor("maxRuntimeMode")} />
      </SettingsRow>

      <SettingsRow
        id={limitAnchor("clients")}
        invalid={invalid("clients")}
        title="Clients"
        description="How the server may run. Without remote, it listens only on a loopback address and signs out devices that paired earlier. On machines with the desktop app, keep Desktop app in the list."
        status={<code className="font-mono text-xs text-ink-muted">limits.clients</code>}
        control={
          <StateToggle
            label="Clients policy state"
            value={limits.clients === undefined ? "unset" : "set"}
            states={["unset", "set"] as const}
            labels={{ unset: "Not set", set: "Only these" }}
            onChange={(next) =>
              setLimit(["clients"], next === "unset" ? undefined : ["desktop", "local-browser"])
            }
          />
        }
      >
        {Array.isArray(limits.clients) ? (
          <CheckList
            items={CLIENTS}
            selected={limits.clients}
            onChange={(selected) => setLimit(["clients"], selected)}
          />
        ) : null}
        <ProblemList problems={problemsFor("clients")} />
      </SettingsRow>

      {CAPABILITIES.map((capability) => (
        <SettingsRow
          key={capability.key}
          id={limitAnchor(capability.key)}
          invalid={invalid(capability.key)}
          title={capability.title}
          description={capability.description}
          status={<code className="font-mono text-xs text-ink-muted">limits.{capability.key}</code>}
          control={
            <StateToggle
              label={`${capability.title} policy state`}
              value={triOf(limits[capability.key])}
              states={["unset", "allow", "deny"] as const}
              labels={TRI_LABELS}
              onChange={(next) =>
                setLimit([capability.key], next === "unset" ? undefined : next === "allow")
              }
            />
          }
        >
          <ProblemList problems={problemsFor(capability.key)} />
        </SettingsRow>
      ))}

      <SettingsRow
        id={limitAnchor("providers.allowedDrivers")}
        invalid={invalid("providers.allowedDrivers") || invalid("providers")}
        title="Allowed providers"
        description="The providers that may run. Threads on other providers stay, marked unavailable."
        status={
          <code className="font-mono text-xs text-ink-muted">limits.providers.allowedDrivers</code>
        }
        control={
          <StateToggle
            label="Allowed providers policy state"
            value={providers.allowedDrivers === undefined ? "unset" : "set"}
            states={["unset", "set"] as const}
            labels={{ unset: "Not set", set: "Only these" }}
            onChange={(next) =>
              setLimit(
                ["providers", "allowedDrivers"],
                next === "unset" ? undefined : ["codex", "claudeAgent"],
              )
            }
          />
        }
      >
        {Array.isArray(providers.allowedDrivers) ? (
          <CheckList
            items={KNOWN_DRIVERS}
            selected={providers.allowedDrivers}
            onChange={(selected) => setLimit(["providers", "allowedDrivers"], selected)}
          />
        ) : null}
        <ProblemList
          problems={[...problemsFor("providers.allowedDrivers"), ...problemsFor("providers")]}
        />
      </SettingsRow>

      <SettingsRow
        id={limitAnchor("providers.instances")}
        title="Provider fields"
        description="Fields set on every instance of a provider, such as an environment variable that routes Claude through Amazon Bedrock or a base URL for a company gateway. A locked codex entry rules out Connect with ChatGPT; a locked opencode entry rules out a server URL."
        status={
          <code className="font-mono text-xs text-ink-muted">limits.providers.instances</code>
        }
      >
        <div className="mt-3 space-y-2">
          {Object.entries(instances).map(([driverId, pin]) => (
            <ProviderPin
              key={driverId}
              driverId={driverId}
              pin={pin}
              problems={problemsFor("providers.instances", driverId)}
              setLimit={setLimit}
            />
          ))}
          {unaddedDrivers.length > 0 ? (
            <Select
              value={null}
              onValueChange={(driverId) => {
                if (typeof driverId === "string") {
                  setLimit(["providers", "instances", driverId], { locked: true });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Pin fields for a provider">
                <SelectValue>{() => "Pin fields for a provider…"}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {unaddedDrivers.map((driver) => (
                  <SelectItem key={driver.id} value={driver.id}>
                    {driver.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        id={limitAnchor("updates")}
        invalid={invalid("updates")}
        title="Updates"
        description="Off stops T3 Code from checking for updates, for machines that get it through device management. A feed URL makes the desktop app update from your own mirror of the release feed."
        status={<code className="font-mono text-xs text-ink-muted">limits.updates</code>}
        control={
          <StateToggle
            label="Updates policy state"
            value={updates === undefined ? "unset" : "set"}
            states={["unset", "set"] as const}
            labels={{ unset: "Not set", set: "Set" }}
            onChange={(next) =>
              setLimit(["updates"], next === "unset" ? undefined : { mode: "auto" })
            }
          />
        }
      >
        {updates === undefined ? null : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-xs text-ink-muted">
              <span>Mode</span>
              <Select
                value={typeof updates.mode === "string" ? updates.mode : "auto"}
                onValueChange={(mode) => {
                  if (mode !== null) setLimit(["updates", "mode"], mode);
                }}
              >
                <SelectTrigger size="sm" aria-label="Update mode">
                  <SelectValue>
                    {(mode: string) =>
                      mode === "off" ? "Off: never check" : "Auto: normal update flow"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value="auto">Auto: normal update flow</SelectItem>
                  <SelectItem value="off">Off: never check</SelectItem>
                </SelectPopup>
              </Select>
            </label>
            <OptionalText
              label="Feed URL (https)"
              placeholder="GitHub releases"
              value={updates.feedUrl}
              onChange={(value) => setLimit(["updates", "feedUrl"], value)}
            />
            <div className="space-y-1 text-xs text-ink-muted sm:col-span-2">
              <span className="block">Nightly channel</span>
              <StateToggle
                label="Nightly channel policy state"
                value={triOf(updates.allowNightly)}
                states={["unset", "allow", "deny"] as const}
                labels={TRI_LABELS}
                onChange={(next) =>
                  setLimit(
                    ["updates", "allowNightly"],
                    next === "unset" ? undefined : next === "allow",
                  )
                }
              />
            </div>
          </div>
        )}
        <ProblemList problems={problemsFor("updates")} />
      </SettingsRow>

      {unknownKeys.map((key) => (
        <SettingsRow
          key={key}
          id={limitAnchor(key)}
          invalid
          title={<code>limits.{key}</code>}
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              onClick={() => setLimit([key], undefined)}
            >
              <Trash2Icon />
              Remove
            </Button>
          }
        >
          <ProblemList problems={problemsFor(key)} />
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
