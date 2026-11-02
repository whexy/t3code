import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import type { SettingRow } from "../policy/catalog.ts";
import { isRecord } from "../policy/json.ts";
import type { Problem } from "../policy/validate.ts";
import {
  describeValue,
  initialValue,
  JsonEditor,
  ProblemList,
  type SettingState,
  StateToggle,
  ValueControl,
} from "./controls.tsx";
import { SettingsRow } from "./settingsLayout.tsx";

export interface PolicyKey {
  readonly key: string;
  readonly entry: unknown;
  readonly problems: ReadonlyArray<Problem>;
}

export type SetSetting = (
  key: string,
  entry: { value: unknown; locked: boolean } | undefined,
) => void;

export const settingAnchor = (key: string) => `setting:${key}`;

function stateOf(entry: unknown): SettingState {
  if (entry === undefined) return "unset";
  return isRecord(entry) && entry.locked === true ? "locked" : "default";
}

const valueOf = (entry: unknown) => (isRecord(entry) ? entry.value : undefined);

function KeyHeader({
  policyKey,
  onRemove,
  children,
}: {
  readonly policyKey: string;
  readonly onRemove: () => void;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <code className="min-w-0 break-all text-xs text-foreground">{policyKey}</code>
      <div className="flex items-center gap-1.5">
        {children}
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          aria-label={`Remove ${policyKey}`}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
}

/** One entry of a record setting, such as `providerInstances.<id>`, managed on its own. */
function EntryEditor({
  item,
  setSetting,
}: {
  readonly item: PolicyKey;
  readonly setSetting: SetSetting;
}) {
  const state = stateOf(item.entry);
  return (
    <div
      id={settingAnchor(item.key)}
      className="scroll-mt-20 space-y-2 rounded-lg border border-border/60 p-2.5"
    >
      <KeyHeader policyKey={item.key} onRemove={() => setSetting(item.key, undefined)}>
        <StateToggle
          label={`${item.key} state`}
          value={state === "unset" ? "default" : state}
          states={["default", "locked"] as const}
          onChange={(next) =>
            setSetting(item.key, { value: valueOf(item.entry), locked: next === "locked" })
          }
        />
      </KeyHeader>
      <JsonEditor
        label={`${item.key} value`}
        value={valueOf(item.entry)}
        onChange={(value) => setSetting(item.key, { value, locked: state === "locked" })}
      />
      <ProblemList problems={item.problems} />
    </div>
  );
}

function AddEntry({
  path,
  onAdd,
}: {
  readonly path: string;
  readonly onAdd: (id: string) => void;
}) {
  const [id, setId] = useState("");
  const add = () => {
    if (id.trim() === "") return;
    onAdd(id.trim());
    setId("");
  };
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <Input
        size="sm"
        aria-label={`New ${path} entry`}
        placeholder="Entry key"
        spellCheck={false}
        autoCapitalize="none"
        value={id}
        onChange={(event) => setId(event.target.value)}
      />
      <Button type="submit" size="sm" variant="outline" disabled={id.trim() === ""}>
        <PlusIcon />
        Add entry
      </Button>
    </form>
  );
}

export function SettingRowView({
  row,
  entry,
  problems,
  entries,
  strays,
  setSetting,
}: {
  readonly row: SettingRow;
  readonly entry: unknown;
  readonly problems: ReadonlyArray<Problem>;
  /** Keys naming one entry of this record setting. */
  readonly entries: ReadonlyArray<PolicyKey>;
  /** Keys the editor does not show whose nearest setting is this one. */
  readonly strays: ReadonlyArray<PolicyKey>;
  readonly setSetting: SetSetting;
}) {
  const state = stateOf(entry);
  const value = state === "unset" ? row.builtIn : valueOf(entry);
  const { control } = row;
  const setValue = (next: unknown) =>
    setSetting(row.path, { value: next, locked: state === "locked" });
  const changeState = (next: SettingState) =>
    setSetting(
      row.path,
      next === "unset"
        ? undefined
        : {
            value: state === "unset" ? initialValue(control, row.builtIn) : valueOf(entry),
            locked: next === "locked",
          },
    );
  const allProblems = [
    ...problems,
    ...entries.flatMap((item) => item.problems),
    ...strays.flatMap((item) => item.problems),
  ];
  const inline =
    control.kind === "json" ? null : (
      // Unset, the control shows the built-in value and waits for a state to be chosen.
      <div
        inert={state === "unset"}
        className={
          state === "unset" ? "flex items-center gap-2 opacity-50" : "flex items-center gap-2"
        }
      >
        <ValueControl control={control} value={value} onChange={setValue} label={row.title} />
      </div>
    );

  return (
    <SettingsRow
      id={settingAnchor(row.path)}
      invalid={allProblems.some((problem) => problem.severity === "error")}
      title={row.title}
      description={row.description}
      status={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <code className="text-[11px] text-muted-foreground/80">{row.path}</code>
          <span>Built-in default: {describeValue(control, row.builtIn)}</span>
        </span>
      }
      control={
        <>
          {inline}
          <StateToggle
            label={`${row.title} policy state`}
            value={state}
            states={["unset", "default", "locked"] as const}
            onChange={changeState}
          />
        </>
      }
    >
      {control.kind === "json" && state !== "unset" ? (
        <div className="mt-3">
          <JsonEditor label={`${row.title} value`} value={value} onChange={setValue} />
        </div>
      ) : null}
      <ProblemList problems={problems} />
      {row.hasEntries ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Entries a policy manages one at a time, as <code>{row.path}.&lt;key&gt;</code>. A
            default cannot add an entry, so lock new ones.
          </p>
          {entries.map((item) => (
            <EntryEditor key={item.key} item={item} setSetting={setSetting} />
          ))}
          <AddEntry
            path={row.path}
            onAdd={(id) => setSetting(`${row.path}.${id}`, { value: {}, locked: true })}
          />
        </div>
      ) : null}
      {strays.length > 0 ? (
        <div className="mt-3 space-y-2">
          {strays.map((item) => (
            <div
              key={item.key}
              id={settingAnchor(item.key)}
              className="scroll-mt-20 space-y-2 rounded-lg border border-destructive/32 p-2.5"
            >
              <KeyHeader policyKey={item.key} onRemove={() => setSetting(item.key, undefined)} />
              <JsonEditor label={`${item.key} as written`} value={item.entry} readOnly />
              <ProblemList problems={item.problems} />
            </div>
          ))}
        </div>
      ) : null}
    </SettingsRow>
  );
}
