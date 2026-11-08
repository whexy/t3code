import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";

import { makeManagedSettings } from "../../../server/src/policy/managedSettings.ts";
import { getPath } from "./json.ts";
import { SETTINGS_COPY, SETTINGS_SECTIONS, type SettingCopy } from "./settingsCopy.ts";

/** Settings as `settings.json` holds them before the user changes anything; policy values use this form. */
export const BUILT_IN_SETTINGS: unknown =
  Schema.encodeSync(ServerSettings)(DEFAULT_SERVER_SETTINGS);

const legacy = (replacement: string) =>
  `A legacy setting that "${replacement}" replaced; it applies only while that one is untouched, so manage "${replacement}" instead.`;

/**
 * Settings the server accepts in a policy that are not user choices: state it keeps for itself,
 * and legacy inputs a newer setting replaced. The editor hides them and refuses a file naming them.
 */
export const HIDDEN_SETTINGS: ReadonlyMap<string, string> = new Map([
  [
    "projectSettingsFolded",
    "State the server keeps: it records that old per-project settings were folded in once.",
  ],
  [
    "previousWorktreesDirectories",
    "State the server keeps: past worktree folders, so it can still clean them up.",
  ],
  [
    "deviceOnboardingCompleted",
    "State the server keeps: it records that device setup was finished.",
  ],
  [
    "defaultThemeSetAt",
    "State the server keeps: it stamps each `t3 theme` change so clients apply it.",
  ],
  ["backgroundActivity.schemaVersion", "The format version of backgroundActivity, not a choice."],
  ["automaticGitFetchInterval", legacy("backgroundActivity.overrides.automaticGitFetchInterval")],
  [
    "providerHealthRefreshInterval",
    legacy("backgroundActivity.overrides.providerHealthRefreshInterval"),
  ],
  ["backgroundActivityProfile", legacy("backgroundActivity.profile")],
]);

export type ControlOptionValue = string | number | boolean | null;

export type SettingControl =
  | { readonly kind: "switch" }
  | {
      readonly kind: "select";
      readonly options: ReadonlyArray<{
        readonly value: ControlOptionValue;
        readonly label: string;
        readonly description?: string;
      }>;
    }
  | {
      readonly kind: "number";
      readonly nullable: boolean;
      readonly scale: number;
      readonly unit?: string;
      readonly min?: number;
      readonly max?: number;
      readonly enabledValue?: number;
    }
  | { readonly kind: "text"; readonly multiline: boolean }
  | { readonly kind: "json" };

export interface SettingRow {
  readonly path: string;
  readonly segments: ReadonlyArray<string>;
  readonly section: string;
  readonly group: string | null;
  readonly title: string;
  /** False when T3's Settings page has no control for this path. */
  readonly onSettingsPage: boolean;
  readonly description: string | null;
  readonly control: SettingControl;
  /** The encoded built-in default, what "not set" means. Undefined when T3 decides at run time. */
  readonly builtIn: unknown;
  /** A record such as `providerInstances`, whose entries a policy can also manage one at a time. */
  readonly hasEntries: boolean;
}

export interface SettingSection {
  readonly id: string;
  readonly label: string;
  readonly rows: ReadonlyArray<SettingRow>;
}

export const OTHER_SECTION = { id: "other", label: "Other settings" } as const;

interface Shape {
  readonly nullable: boolean;
  readonly literals: ReadonlyArray<ControlOptionValue>;
  readonly kinds: ReadonlySet<string>;
  readonly struct?: AST.Objects;
}

/** What JSON a setting holds, from its encoded schema. */
function shapeOf(ast: AST.AST): Shape {
  const members: AST.AST[] = [];
  const collect = (node: AST.AST) => {
    const encoded = AST.toEncoded(node);
    if (AST.isUnion(encoded)) encoded.types.forEach(collect);
    else members.push(encoded);
  };
  collect(ast);
  const literals: ControlOptionValue[] = [];
  const kinds = new Set<string>();
  let nullable = false;
  let struct: AST.Objects | undefined;
  for (const member of members) {
    if (AST.isUndefined(member)) continue;
    if (AST.isNull(member)) nullable = true;
    else if (AST.isLiteral(member) && typeof member.literal !== "bigint") {
      literals.push(member.literal);
      kinds.add("literal");
    } else if (AST.isObjects(member)) {
      if (member.indexSignatures.length > 0 && member.propertySignatures.length === 0) {
        kinds.add("record");
      } else {
        kinds.add("struct");
        struct ??= member;
      }
    } else kinds.add(member._tag);
  }
  return { nullable, literals, kinds, ...(struct === undefined ? {} : { struct }) };
}

const onlyKind = (shape: Shape, kind: string) => shape.kinds.size === 1 && shape.kinds.has(kind);

function controlFor(shape: Shape, copy: SettingCopy | undefined): SettingControl {
  const unknown = onlyKind(shape, "Unknown");
  const wanted =
    copy?.control ??
    (onlyKind(shape, "Boolean")
      ? "switch"
      : onlyKind(shape, "literal")
        ? "select"
        : onlyKind(shape, "Number")
          ? "number"
          : onlyKind(shape, "String")
            ? "text"
            : "json");
  if (wanted === "switch" && (onlyKind(shape, "Boolean") || unknown) && !shape.nullable) {
    return { kind: "switch" };
  }
  const copied = copy?.options ?? [];
  // Any string is valid, so the copy's choices are what is offered, as the Settings page lists them.
  const openString =
    copied.length > 0 &&
    shape.kinds.has("String") &&
    [...shape.kinds].every((kind) => kind === "String" || kind === "literal");
  if (wanted === "select" && (onlyKind(shape, "literal") || unknown || openString)) {
    // The schema's values decide what is offered; the Settings page supplies their labels.
    const values: ControlOptionValue[] =
      unknown || openString
        ? copied.map((option) => option.value)
        : [...(shape.nullable ? [null] : []), ...shape.literals];
    return {
      kind: "select",
      options: values.map((value) => {
        const option = copied.find((candidate) => candidate.value === value);
        return {
          value,
          label: option?.label ?? (value === null ? "None" : String(value)),
          ...(option?.description === undefined ? {} : { description: option.description }),
        };
      }),
    };
  }
  if (wanted === "number" && onlyKind(shape, "Number")) {
    return {
      kind: "number",
      nullable: shape.nullable,
      scale: copy?.scale ?? 1,
      ...(copy?.unit === undefined ? {} : { unit: copy.unit }),
      ...(copy?.min === undefined ? {} : { min: copy.min }),
      ...(copy?.max === undefined ? {} : { max: copy.max }),
      ...(copy?.enabledValue === undefined ? {} : { enabledValue: copy.enabledValue }),
    };
  }
  if (
    (wanted === "text" || wanted === "textarea") &&
    onlyKind(shape, "String") &&
    !shape.nullable
  ) {
    return { kind: "text", multiline: wanted === "textarea" };
  }
  return { kind: "json" };
}

/**
 * Whether the server manages `path`: it takes the built-in value there as a default or as a lock.
 * A default skips the rules between locks, and a lock the rule against defaults adding entries.
 */
const serverManages = (path: string) =>
  [false, true].some(
    (locked) =>
      makeManagedSettings({
        [path]: { value: getPath(BUILT_IN_SETTINGS, path.split(".")), locked },
      })._tag === "Valid",
  );

function buildCatalog(): ReadonlyArray<SettingSection> {
  const copyByPath = new Map(SETTINGS_COPY.map((copy) => [copy.path, copy]));
  const rows: SettingRow[] = [];

  // A setting the Settings page edits field by field gets a row per field, including fields
  // added since the copy was taken.
  const addRows = (path: string, ast: AST.AST) => {
    if (HIDDEN_SETTINGS.has(path) || !serverManages(path)) return;
    const shape = shapeOf(ast);
    const split = SETTINGS_COPY.some((copy) => copy.path.startsWith(`${path}.`));
    if (split && shape.struct !== undefined && !shape.nullable) {
      for (const property of shape.struct.propertySignatures) {
        addRows(`${path}.${String(property.name)}`, property.type);
      }
      return;
    }
    const copy = copyByPath.get(path);
    const segments = path.split(".");
    rows.push({
      path,
      segments,
      section: copy?.section ?? OTHER_SECTION.id,
      group: copy?.group ?? null,
      title: copy?.title ?? path,
      onSettingsPage: copy !== undefined,
      description: copy?.description ?? null,
      control: controlFor(shape, copy),
      builtIn: getPath(BUILT_IN_SETTINGS, segments),
      hasEntries: onlyKind(shape, "record") && !shape.nullable,
    });
  };
  for (const [key, field] of Object.entries(ServerSettings.fields)) addRows(key, field.ast);

  const order = (row: SettingRow) => {
    const index = SETTINGS_COPY.findIndex((copy) => copy.path === row.path);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...SETTINGS_SECTIONS, OTHER_SECTION]
    .map((section) => ({
      ...section,
      rows: rows
        .filter((row) => row.section === section.id)
        .toSorted((left, right) => order(left) - order(right)),
    }))
    .filter((section) => section.rows.length > 0);
}

export const SETTING_SECTIONS: ReadonlyArray<SettingSection> = buildCatalog();
export const SETTING_ROWS: ReadonlyMap<string, SettingRow> = new Map(
  SETTING_SECTIONS.flatMap((section) => section.rows.map((row) => [row.path, row] as const)),
);

/** The row a policy key belongs to: its own, or the record whose entry it names. */
export function rowForKey(key: string): SettingRow | undefined {
  const own = SETTING_ROWS.get(key);
  if (own !== undefined) return own;
  const segments = key.split(".");
  const parent = SETTING_ROWS.get(segments.slice(0, -1).join("."));
  return parent?.hasEntries === true && segments.at(-1) !== "" ? parent : undefined;
}

/** The nearest row at or above `key`, to show a problem with a key the editor does not show. */
export function nearestRow(key: string): SettingRow | undefined {
  const segments = key.split(".");
  for (let length = segments.length; length > 0; length -= 1) {
    const row = SETTING_ROWS.get(segments.slice(0, length).join("."));
    if (row !== undefined) return row;
  }
  return [...SETTING_ROWS.values()].find((row) => row.path.startsWith(`${key}.`));
}
