import {
  BotIcon,
  ClipboardPasteIcon,
  DownloadIcon,
  FilePlusIcon,
  FlaskConicalIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  type LucideIcon,
  MessagesSquareIcon,
  PanelsTopLeftIcon,
  SaveIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import { nearestRow, rowForKey, SETTING_SECTIONS } from "./policy/catalog.ts";
import {
  NEW_POLICY,
  type OpenedText,
  parsePolicyText,
  serializePolicy,
} from "./policy/document.ts";
import {
  canWriteInPlace,
  download,
  type OpenedFile,
  pickPolicyFile,
  type PolicyFileHandle,
  readDroppedFile,
  readInputFile,
  saveAs,
  writeInPlace,
} from "./policy/files.ts";
import { isRecord, jsonEqual, setPath } from "./policy/json.ts";
import { type Problem, type ProblemTarget, validatePolicy } from "./policy/validate.ts";
import { JsonEditor, ProblemList } from "./ui/controls.tsx";
import { limitAnchor, LimitsSection } from "./ui/LimitsSection.tsx";
import { type PolicyKey, settingAnchor, SettingRowView } from "./ui/SettingRowView.tsx";
import { SettingsGroupHeading, SettingsRow, SettingsSection } from "./ui/settingsLayout.tsx";

const SECTION_ICONS: Record<string, LucideIcon> = {
  "/settings/providers": BotIcon,
  "/settings/threads": MessagesSquareIcon,
  "/settings/browser": GlobeIcon,
  "/settings/devices": SmartphoneIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/worktrees": FolderTreeIcon,
  "/settings/access": ShieldCheckIcon,
  "/settings/secrets": KeyRoundIcon,
  "/settings/maintenance": WrenchIcon,
  "/settings/diagnostics": WrenchIcon,
  "/settings/labs": FlaskConicalIcon,
};

interface Editing {
  readonly document: unknown;
  /** The file as opened or last saved; saving it unchanged writes these bytes back. */
  readonly opened: OpenedText | undefined;
  readonly name: string;
  readonly handle: PolicyFileHandle | undefined;
}

const FRESH: Editing = {
  document: NEW_POLICY,
  opened: undefined,
  name: "policy.json",
  handle: undefined,
};

const sectionAnchor = (id: string) => `section:${id}`;

function anchorFor(target: ProblemTarget): string {
  switch (target.kind) {
    case "setting":
      return settingAnchor(target.key);
    case "limit":
      return target.key === "providers"
        ? limitAnchor("providers.allowedDrivers")
        : limitAnchor(target.key, target.entry);
    case "document":
      return target.key === undefined ? "problems" : `policy:${target.key}`;
  }
}

function describeTarget(target: ProblemTarget): string {
  switch (target.kind) {
    case "setting":
      return `settings › ${target.key}`;
    case "limit":
      return `limits › ${target.key}${target.entry === undefined ? "" : ` › ${target.entry}`}`;
    case "document":
      return target.key ?? "policy";
  }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function summaryLine(serverRefuses: boolean, errors: number, warnings: number): string {
  if (serverRefuses) return `${plural(errors, "problem")}: t3 policy check refuses this policy`;
  if (errors > 0) {
    return `${plural(errors, "problem")}: t3 policy check accepts it, but it names settings this editor does not manage`;
  }
  return `t3 policy check accepts this policy${warnings > 0 ? `, with ${plural(warnings, "warning")}` : ""}`;
}

const scrollTo = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

export function App() {
  const [editing, setEditing] = useState<Editing>(FRESH);
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | undefined>();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const { document: policy } = editing;
  const checked = useDeferredValue(policy);
  const verdict = useMemo(() => validatePolicy(checked), [checked]);
  const text = serializePolicy(policy, editing.opened);
  const dirty =
    editing.opened === undefined ? !jsonEqual(policy, NEW_POLICY) : text !== editing.opened.text;
  const errors = verdict.problems.filter((problem) => problem.severity === "error");
  const warnings = verdict.problems.filter((problem) => problem.severity === "warning");

  const edit = (segments: ReadonlyArray<string>, value: unknown) =>
    setEditing((current) => ({ ...current, document: setPath(current.document, segments, value) }));
  const setSetting = (key: string, entry: { value: unknown; locked: boolean } | undefined) =>
    edit(["settings", key], entry);

  const load = (file: OpenedFile) => {
    const parsed = parsePolicyText(file.text);
    if (!parsed.ok) return setNotice({ tone: "error", text: `${file.name}: ${parsed.message}` });
    if (!isRecord(parsed.document)) {
      return setNotice({ tone: "error", text: `${file.name}: a policy is a JSON object.` });
    }
    if (dirty && !window.confirm("Discard the changes to the current policy?")) return;
    setEditing({
      document: parsed.document,
      opened: { text: file.text, document: parsed.document },
      name: file.name,
      handle: file.handle,
    });
    setNotice({
      tone: "info",
      text: file.handle
        ? `Opened ${file.name}. Save writes back to it.`
        : `Opened ${file.name}. Save downloads a copy.`,
    });
  };

  const open = async () => {
    if (!canWriteInPlace()) return fileInput.current?.click();
    const file = await pickPolicyFile();
    if (file !== undefined) load(file);
  };

  const save = async () => {
    if (!verdict.valid && !window.confirm("t3 policy check refuses this policy. Save it anyway?"))
      return;
    try {
      if (editing.handle !== undefined && (await writeInPlace(editing.handle, text))) {
        setEditing((current) => ({ ...current, opened: { text, document: current.document } }));
        return setNotice({ tone: "info", text: `Saved ${editing.name}.` });
      }
      const saved = await saveAs(editing.name, text);
      if (saved === undefined) return;
      setEditing((current) => ({
        ...current,
        name: saved.name,
        handle: saved.handle,
        opened: { text, document: current.document },
      }));
      setNotice({
        tone: "info",
        text: saved.handle ? `Saved ${saved.name}.` : `Downloaded ${saved.name}.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: `Could not save: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  // Warn before closing with unsaved changes, and save on Cmd/Ctrl+S: both are window events.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("keydown", shortcut);
    };
  });

  const problemsOf = (match: (target: ProblemTarget) => boolean): ReadonlyArray<Problem> =>
    verdict.problems.filter((problem) => match(problem.target));
  const settingProblems = (key: string) =>
    problemsOf((target) => target.kind === "setting" && target.key === key);
  const documentProblems = (key: string) =>
    problemsOf((target) => target.kind === "document" && target.key === key);

  const settings = isRecord(policy) && isRecord(policy.settings) ? policy.settings : {};
  const keyItem = (key: string): PolicyKey => ({
    key,
    entry: settings[key],
    problems: settingProblems(key),
  });
  const entryKeys = (path: string) =>
    Object.keys(settings).filter((key) => key !== path && rowForKey(key)?.path === path);
  const strayKeys = Object.keys(settings).filter((key) => rowForKey(key) === undefined);
  const straysAt = (path: string) => strayKeys.filter((key) => nearestRow(key)?.path === path);
  const orphanKeys = strayKeys.filter((key) => nearestRow(key) === undefined);
  const record = isRecord(policy) ? policy : {};
  const unknownTopKeys = Object.keys(record).filter(
    (key) => !["schemaVersion", "organization", "supportUrl", "settings", "limits"].includes(key),
  );

  const sectionOf = (target: ProblemTarget) =>
    target.kind === "document"
      ? "policy"
      : target.kind === "limit"
        ? "limits"
        : (rowForKey(target.key) ?? nearestRow(target.key))?.section;
  const errorCount = (section: string) =>
    errors.filter((problem) => sectionOf(problem.target) === section).length;
  const nav = [
    { id: "policy", label: "Policy", icon: ShieldIcon },
    { id: "limits", label: "Limits", icon: SlidersHorizontalIcon },
    ...SETTING_SECTIONS.map((section) => ({
      id: section.id,
      label: section.label,
      icon: SECTION_ICONS[section.id] ?? SlidersHorizontalIcon,
    })),
  ].map((item) => ({ ...item, count: errorCount(item.id) }));

  return (
    <div
      className="relative flex min-h-dvh bg-background text-foreground"
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void readDroppedFile(event.dataTransfer).then((file) => file && load(file));
      }}
    >
      {dragging ? (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/80 text-sm font-medium">
          Drop a policy file to open it
        </div>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void readInputFile(file).then(load);
        }}
      />

      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 overflow-y-auto border-r border-border/60 bg-sidebar px-2 py-4 md:block">
        <div className="px-2 pb-4 text-sm font-semibold">Policy editor</div>
        <nav className="flex flex-col gap-0.5">
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => scrollTo(sectionAnchor(item.id))}
              className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent"
            >
              <item.icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.count > 0 ? (
                <Badge variant="error" size="sm">
                  {item.count}
                </Badge>
              ) : null}
            </button>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/90 backdrop-blur">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{editing.name}</span>
                {dirty ? (
                  <Badge variant="warning" size="sm">
                    Unsaved
                  </Badge>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => scrollTo("problems")}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {summaryLine(verdict.serverReason !== undefined, errors.length, warnings.length)}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (dirty && !window.confirm("Discard the changes to the current policy?"))
                    return;
                  setEditing(FRESH);
                  setNotice(undefined);
                }}
              >
                <FilePlusIcon />
                New
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void open()}>
                <FolderOpenIcon />
                Open
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPasteOpen(true)}>
                <ClipboardPasteIcon />
                Paste
              </Button>
              <Button size="sm" variant="ghost" onClick={() => download(editing.name, text)}>
                <DownloadIcon />
                Download
              </Button>
              <Button size="sm" onClick={() => void save()}>
                <SaveIcon />
                {editing.handle ? "Save" : "Save as…"}
              </Button>
            </div>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pt-6 pb-24 sm:px-6">
          {notice ? (
            <div
              role="status"
              className={
                notice.tone === "error"
                  ? "rounded-xl border border-destructive/32 bg-destructive/4 px-4 py-2.5 text-sm text-destructive-foreground"
                  : "rounded-xl border border-border/60 bg-card/40 px-4 py-2.5 text-sm text-muted-foreground"
              }
            >
              {notice.text}
            </div>
          ) : null}

          <section id="problems" className="scroll-mt-20 space-y-2">
            {verdict.problems.length === 0 ? (
              <p className="px-3 text-sm text-muted-foreground sm:px-4">
                Each setting can be left{" "}
                <strong className="font-medium text-foreground">not set</strong> (the user's own
                value, or the built-in default), given a{" "}
                <strong className="font-medium text-foreground">default</strong> users can change,
                or <strong className="font-medium text-foreground">locked</strong>. Open or drop a
                policy file to edit it.
              </p>
            ) : (
              <div className="rounded-xl border border-border/60 bg-card/40 p-3 sm:p-4">
                <h2 className="pb-2 text-sm font-semibold">
                  {errors.length > 0 ? "Problems" : "Warnings"}
                </h2>
                <ul className="space-y-1.5">
                  {verdict.problems.map((problem) => (
                    <li
                      key={`${JSON.stringify(problem.target)}${problem.message}`}
                      className="text-xs"
                    >
                      <button
                        type="button"
                        onClick={() => scrollTo(anchorFor(problem.target))}
                        className={
                          problem.severity === "error"
                            ? "text-left text-destructive-foreground hover:underline"
                            : "text-left text-warning-foreground hover:underline"
                        }
                      >
                        <code className="font-medium">{describeTarget(problem.target)}</code>:{" "}
                        {problem.message}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <SettingsSection id={sectionAnchor("policy")} title="Policy">
            <SettingsRow
              id="policy:organization"
              invalid={documentProblems("organization").length > 0}
              title="Organization"
              description='Shown to users in Settings and beside each control the policy locks, as "Managed by <organization>".'
              status={<code className="text-[11px] text-muted-foreground/80">organization</code>}
              control={
                <Input
                  size="sm"
                  aria-label="Organization"
                  placeholder="Example Corp"
                  value={typeof record.organization === "string" ? record.organization : ""}
                  onChange={(event) => edit(["organization"], event.target.value)}
                />
              }
            >
              <ProblemList problems={documentProblems("organization")} />
            </SettingsRow>
            <SettingsRow
              id="policy:supportUrl"
              invalid={documentProblems("supportUrl").length > 0}
              title="Support URL"
              description="Users see a link to it beside each locked control. Optional."
              status={<code className="text-[11px] text-muted-foreground/80">supportUrl</code>}
              control={
                <Input
                  size="sm"
                  aria-label="Support URL"
                  placeholder="https://it.example.com/t3"
                  spellCheck={false}
                  value={typeof record.supportUrl === "string" ? record.supportUrl : ""}
                  onChange={(event) =>
                    edit(["supportUrl"], event.target.value === "" ? undefined : event.target.value)
                  }
                />
              }
            >
              <ProblemList problems={documentProblems("supportUrl")} />
            </SettingsRow>
            <SettingsRow
              id="policy:schemaVersion"
              invalid={documentProblems("schemaVersion").length > 0}
              title="Schema version"
              description="The policy format. This version of T3 Code reads version 1."
              status={<code className="text-[11px] text-muted-foreground/80">schemaVersion</code>}
              control={
                record.schemaVersion === 1 ? (
                  <span className="text-sm">1</span>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => edit(["schemaVersion"], 1)}>
                    Use version 1
                  </Button>
                )
              }
            >
              <ProblemList problems={documentProblems("schemaVersion")} />
            </SettingsRow>
            {unknownTopKeys.map((key) => (
              <SettingsRow
                key={key}
                id={`policy:${key}`}
                invalid
                title={<code>{key}</code>}
                control={
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    onClick={() => edit([key], undefined)}
                  >
                    <Trash2Icon />
                    Remove
                  </Button>
                }
              >
                <ProblemList problems={documentProblems(key)} />
              </SettingsRow>
            ))}
          </SettingsSection>

          <LimitsSection
            limits={record.limits}
            setLimit={(segments, value) => edit(["limits", ...segments], value)}
            problemsFor={(key, entry) =>
              problemsOf(
                (target) => target.kind === "limit" && target.key === key && target.entry === entry,
              )
            }
          />

          {orphanKeys.length > 0 ? (
            <SettingsSection
              id="section:unshown"
              title="Settings this editor does not show"
              description="Remove these keys; the policy is not valid in the editor while they remain."
            >
              {orphanKeys.map((key) => (
                <SettingsRow
                  key={key}
                  id={settingAnchor(key)}
                  invalid
                  title={<code>{key}</code>}
                  control={
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      onClick={() => setSetting(key, undefined)}
                    >
                      <Trash2Icon />
                      Remove
                    </Button>
                  }
                >
                  <div className="mt-3">
                    <JsonEditor label={`${key} as written`} value={settings[key]} readOnly />
                  </div>
                  <ProblemList problems={settingProblems(key)} />
                </SettingsRow>
              ))}
            </SettingsSection>
          ) : null}

          {SETTING_SECTIONS.map((section) => (
            <SettingsSection
              key={section.id}
              id={sectionAnchor(section.id)}
              title={section.label}
              {...(section.id === "other"
                ? { description: "Settings with no control on T3 Code's Settings page." }
                : {})}
            >
              {section.rows.map((row, index) => (
                <div key={row.path} className="contents">
                  {row.group !== null && row.group !== section.rows[index - 1]?.group ? (
                    <SettingsGroupHeading>{row.group}</SettingsGroupHeading>
                  ) : null}
                  <SettingRowView
                    row={row}
                    entry={settings[row.path]}
                    problems={settingProblems(row.path)}
                    entries={entryKeys(row.path).map(keyItem)}
                    strays={straysAt(row.path).map(keyItem)}
                    setSetting={setSetting}
                  />
                </div>
              ))}
            </SettingsSection>
          ))}

          <SettingsSection
            id="section:json"
            title="Policy JSON"
            description="What Save and Download write."
          >
            <pre className="max-h-96 overflow-auto px-3 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all sm:px-4">
              {text}
            </pre>
          </SettingsSection>
        </div>
      </main>

      <PasteDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        onImport={(pasted) => {
          load({ name: FRESH.name, text: pasted });
          setPasteOpen(false);
        }}
      />
    </div>
  );
}

function PasteDialog({
  open,
  onOpenChange,
  onImport,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onImport: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const parsed = text.trim() === "" ? undefined : parsePolicyText(text);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Paste a policy</DialogTitle>
          <DialogDescription>Paste the policy's JSON to edit it here.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Textarea
            aria-label="Policy JSON"
            className="font-mono"
            rows={12}
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {parsed !== undefined && !parsed.ok ? (
            <p className="text-xs text-destructive-foreground">{parsed.message}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={parsed === undefined || !parsed.ok} onClick={() => onImport(text)}>
            Open
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
