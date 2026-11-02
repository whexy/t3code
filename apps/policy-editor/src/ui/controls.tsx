import { LockIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Input } from "~/components/ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "~/components/ui/number-field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

import type { ControlOptionValue, SettingControl } from "../policy/catalog.ts";
import { jsonEqual } from "../policy/json.ts";
import type { Problem } from "../policy/validate.ts";

export type SettingState = "unset" | "default" | "locked";

const STATE_LABELS: Record<SettingState, ReactNode> = {
  unset: "Not set",
  default: "Default",
  locked: (
    <>
      <LockIcon className="size-3" aria-hidden />
      Locked
    </>
  ),
};

export function StateToggle<State extends string>({
  value,
  onChange,
  label,
  states,
  labels,
}: {
  readonly value: State;
  readonly onChange: (state: State) => void;
  readonly label: string;
  readonly states: ReadonlyArray<State>;
  readonly labels?: Partial<Record<State, ReactNode>>;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const picked = states.find((state) => state === next[0]);
        if (picked !== undefined) onChange(picked);
      }}
    >
      {states.map((state) => (
        <Toggle key={state} value={state}>
          {labels?.[state] ?? STATE_LABELS[state as SettingState] ?? state}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

const optionKey = (value: unknown) => JSON.stringify(value) ?? "undefined";

/** How a value reads in the setting's own terms, for "Built-in default: …". */
export function describeValue(control: SettingControl, value: unknown): string {
  if (value === undefined) return "not set; T3 Code decides";
  switch (control.kind) {
    case "switch":
      return value === true ? "On" : value === false ? "Off" : JSON.stringify(value);
    case "select":
      return (
        control.options.find((option) => option.value === value)?.label ?? JSON.stringify(value)
      );
    case "number":
      if (value === null) return "Off";
      return typeof value === "number"
        ? `${value / control.scale}${control.unit === undefined ? "" : ` ${control.unit}`}`
        : JSON.stringify(value);
    case "text":
      return value === "" ? "Empty" : JSON.stringify(value);
    case "json": {
      if (value === null) return "None";
      const text = JSON.stringify(value);
      return text.length > 64 ? `${text.slice(0, 61)}…` : text;
    }
  }
}

/** The first value a setting takes when it is set, before the administrator changes it. */
export function initialValue(control: SettingControl, builtIn: unknown): unknown {
  if (builtIn !== undefined) return builtIn;
  switch (control.kind) {
    case "switch":
      return false;
    case "select":
      return control.options[0]?.value ?? null;
    case "number":
      return control.nullable ? null : (control.min ?? 0) * control.scale;
    case "text":
      return "";
    case "json":
      return {};
  }
}

export function ValueControl({
  control,
  value,
  onChange,
  label,
}: {
  readonly control: Exclude<SettingControl, { kind: "json" }>;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly label: string;
}) {
  switch (control.kind) {
    case "switch":
      return (
        <Switch
          aria-label={label}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
        />
      );
    case "select": {
      // Undefined only shows a built-in value T3 decides at run time; it is never written.
      const known = value === undefined || control.options.some((option) => option.value === value);
      return (
        <Select
          value={value === undefined ? null : optionKey(value)}
          onValueChange={(key) => {
            const option = control.options.find((candidate) => optionKey(candidate.value) === key);
            if (option !== undefined) onChange(option.value);
          }}
        >
          <SelectTrigger size="sm" aria-label={label}>
            <SelectValue>
              {(key: string | null) =>
                key === null
                  ? "Decided by T3 Code"
                  : (control.options.find((option) => optionKey(option.value) === key)?.label ??
                    key)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {known ? null : <SelectItem value={optionKey(value)}>{optionKey(value)}</SelectItem>}
            {control.options.map((option: { value: ControlOptionValue; label: string }) => (
              <SelectItem key={optionKey(option.value)} value={optionKey(option.value)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      );
    }
    case "number": {
      const shown = typeof value === "number" ? value / control.scale : null;
      const field = (
        <NumberField
          value={shown}
          size="sm"
          className="w-32"
          step={1}
          {...(control.min === undefined ? {} : { min: control.min })}
          {...(control.max === undefined ? {} : { max: control.max })}
          onValueChange={(next) => {
            if (next !== null) onChange(Math.round(next * control.scale));
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={`Decrease ${label}`} />
            <NumberFieldInput aria-label={control.unit ? `${label} in ${control.unit}` : label} />
            <NumberFieldIncrement aria-label={`Increase ${label}`} />
          </NumberFieldGroup>
        </NumberField>
      );
      const unit = control.unit ? (
        <span className="text-xs text-muted-foreground">{control.unit}</span>
      ) : null;
      if (!control.nullable) {
        return (
          <>
            {field}
            {unit}
          </>
        );
      }
      return (
        <>
          {value === null ? <span className="text-xs text-muted-foreground">Off</span> : field}
          {value === null ? null : unit}
          <Switch
            aria-label={`${label} on`}
            checked={value !== null}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? (control.enabledValue ?? (typeof control.min === "number" ? control.min : 1)) *
                      control.scale
                  : null,
              )
            }
          />
        </>
      );
    }
    case "text":
      return control.multiline ? (
        <Textarea
          aria-label={label}
          rows={3}
          value={typeof value === "string" ? value : JSON.stringify(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          aria-label={label}
          size="sm"
          spellCheck={false}
          autoCapitalize="none"
          value={typeof value === "string" ? value : JSON.stringify(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

const pretty = (value: unknown) => (value === undefined ? "" : JSON.stringify(value, null, 2));

/**
 * A JSON value edited as text. Text that does not parse stays as typed, with the parse error,
 * until it parses or the value changes from outside.
 */
export function JsonEditor({
  value,
  onChange,
  label,
  readOnly = false,
}: {
  readonly value: unknown;
  readonly onChange?: (value: unknown) => void;
  readonly label: string;
  readonly readOnly?: boolean;
}) {
  const [draft, setDraft] = useState({ text: pretty(value), source: value, error: "" });
  if (!jsonEqual(draft.source, value)) {
    setDraft({ text: pretty(value), source: value, error: "" });
  }
  const lines = Math.min(16, Math.max(2, draft.text.split("\n").length));
  return (
    <div className="space-y-1">
      <Textarea
        aria-label={label}
        aria-invalid={draft.error !== "" || undefined}
        className="font-mono"
        rows={lines}
        spellCheck={false}
        readOnly={readOnly}
        value={draft.text}
        onChange={(event) => {
          const text = event.target.value;
          try {
            const parsed: unknown = JSON.parse(text);
            setDraft({ text, source: parsed, error: "" });
            onChange?.(parsed);
          } catch (error) {
            setDraft({
              text,
              source: draft.source,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }}
      />
      {draft.error === "" ? null : (
        <p className="text-xs text-destructive-foreground">Not valid JSON: {draft.error}</p>
      )}
    </div>
  );
}

export function ProblemList({ problems }: { readonly problems: ReadonlyArray<Problem> }) {
  if (problems.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {problems.map((problem) => (
        <li
          key={`${JSON.stringify(problem.target)}${problem.message}`}
          className={
            problem.severity === "error"
              ? "text-xs text-destructive-foreground"
              : "text-xs text-warning-foreground"
          }
        >
          <span className="font-medium">
            {problem.severity === "error" ? "Refused: " : "Warning: "}
          </span>
          {problem.message}
          {problem.detail ? (
            <span className="mt-0.5 block font-mono text-[11px] opacity-80">{problem.detail}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
