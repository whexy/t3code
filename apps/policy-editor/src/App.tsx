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
  RefreshCwIcon,
  SaveIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from "react";

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
import { type OpenedText, parsePolicyText, readPolicyText } from "./policy/document.ts";
import {
  canWriteInPlace,
  download,
  type OpenedFile,
  pickPolicyFile,
  readDroppedFile,
  readInputFile,
  saveAs,
  writeInPlace,
} from "./policy/files.ts";
import { isRecord } from "./policy/json.ts";
import { loadRemotePolicy, type RemoteLoad, saveRemotePolicy, sha12 } from "./policy/remote.ts";
import {
  afterRemoteSave,
  FRESH,
  INITIAL_SESSION,
  isDirty,
  sessionReducer,
  type SessionAction,
  textOf,
} from "./policy/session.ts";
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

const loadTask = async (): Promise<SessionAction> => ({
  type: "loaded",
  load: await loadRemotePolicy({ dev: import.meta.env.DEV }),
});

function fleetStatus(fleet: (typeof INITIAL_SESSION)["fleet"]): string | undefined {
  switch (fleet.mode) {
    case "files":
      return undefined;
    case "loading":
      return "loading…";
    case "failed":
      return "not loaded";
    case "ready":
      if (fleet.etag === null) return "not saved yet";
      return fleet.unreadable
        ? `${sha12(fleet.etag)} · cannot be opened`
        : `${sha12(fleet.etag)} · saved ${fleet.savedAt?.toLocaleString() ?? ""}`;
  }
}

export function App({ initialLoad }: { readonly initialLoad: Promise<RemoteLoad> }) {
  const [session, dispatch] = useReducer(sessionReducer, INITIAL_SESSION);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Guards against a second load or save starting before the first one's state renders.
  const inFlight = useRef(true);

  const { editing, fleet, notice, busy } = session;
  const { document: policy } = editing;
  const checked = useDeferredValue(policy);
  const verdict = useMemo(() => validatePolicy(checked), [checked]);
  const text = textOf(editing);
  const dirty = isDirty(editing, text);
  const errors = verdict.problems.filter((problem) => problem.severity === "error");
  const warnings = verdict.problems.filter((problem) => problem.severity === "warning");
  const onFleet = fleet.mode !== "files";
  const canSave = !busy && fleet.mode !== "loading" && fleet.mode !== "failed";

  const edit = (segments: ReadonlyArray<string>, value: unknown) =>
    dispatch({ type: "edit", segments, value });
  const setSetting = (key: string, entry: { value: unknown; locked: boolean } | undefined) =>
    edit(["settings", key], entry);

  /** Runs one load or save at a time; the task's action ends it. */
  const run = (task: () => Promise<SessionAction>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    dispatch({ type: "begin" });
    void task()
      .catch((error: unknown): SessionAction => ({
        type: "settled",
        notice: {
          tone: "error",
          text: `Could not save: ${error instanceof Error ? error.message : String(error)}`,
        },
      }))
      .then((action) => {
        inFlight.current = false;
        dispatch(action);
      });
  };

  // The first load starts before the page renders, so a slow server never blanks it.
  useEffect(() => {
    let current = true;
    void initialLoad.then((load) => {
      if (!current) return;
      inFlight.current = false;
      dispatch({ type: "loaded", load });
    });
    return () => {
      current = false;
    };
  }, [initialLoad]);

  const load = (file: OpenedFile) => {
    if (inFlight.current) return;
    const read = readPolicyText(file.text);
    if (!read.ok) {
      return dispatch({
        type: "notice",
        notice: { tone: "error", text: `${file.name}: ${read.message}` },
      });
    }
    if (dirty && !window.confirm("Discard the changes to the current policy?")) return;
    dispatch({
      type: "replace",
      editing: {
        document: read.document,
        opened: { text: file.text, document: read.document },
        name: file.name,
        handle: file.handle,
      },
      notice: {
        tone: "info",
        text: onFleet
          ? `Opened ${file.name}. Save publishes it as the fleet policy.`
          : file.handle
            ? `Opened ${file.name}. Save writes back to it.`
            : `Opened ${file.name}. Save downloads a copy.`,
      },
    });
  };

  const open = async () => {
    if (!canWriteInPlace()) return fileInput.current?.click();
    const file = await pickPolicyFile();
    if (file !== undefined) load(file);
  };

  const reload = () => {
    if (inFlight.current) return;
    if (dirty && !window.confirm("Discard the changes to the current policy?")) return;
    run(loadTask);
  };

  const saveFile = async (submitted: OpenedText): Promise<SessionAction> => {
    if (editing.handle !== undefined && (await writeInPlace(editing.handle, submitted.text))) {
      return { type: "saved", submitted, notice: { tone: "info", text: `Saved ${editing.name}.` } };
    }
    const saved = await saveAs(editing.name, submitted.text);
    if (saved === undefined) return { type: "settled" };
    return {
      type: "saved",
      submitted,
      file: { name: saved.name, handle: saved.handle },
      notice: {
        tone: "info",
        text: saved.handle ? `Saved ${saved.name}.` : `Downloaded ${saved.name}.`,
      },
    };
  };

  const save = () => {
    if (inFlight.current || !canSave) return;
    if (!verdict.valid && !window.confirm("t3 policy check refuses this policy. Save it anyway?"))
      return;
    const submitted: OpenedText = { text, document: policy };
    if (fleet.mode !== "ready") return run(() => saveFile(submitted));
    if (
      fleet.unreadable &&
      !window.confirm(
        `The saved fleet policy (${sha12(fleet.etag ?? "")}) cannot be opened. Replace it with this policy?`,
      )
    )
      return;
    run(async () => afterRemoteSave(submitted, await saveRemotePolicy(text, fleet.etag)));
  };

  // Warn before closing with unsaved changes, and save on Cmd/Ctrl+S: both are window events.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
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
      // The web stylesheet locks body and #root scrolling, so the editor scrolls its own panes.
      className="relative flex h-dvh overflow-hidden bg-background text-foreground"
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

      <aside className="hidden h-full w-56 shrink-0 overflow-y-auto border-r border-border/60 bg-sidebar px-2 py-4 md:block">
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

      <main className="h-full min-w-0 flex-1 overflow-y-auto scrollbar-gutter-both">
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/90 backdrop-blur">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {onFleet ? "Fleet policy" : editing.name}
                </span>
                {dirty ? (
                  <Badge variant="warning" size="sm">
                    Unsaved
                  </Badge>
                ) : null}
                {onFleet ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {fleetStatus(fleet)}
                  </span>
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
                disabled={busy}
                onClick={() => {
                  if (dirty && !window.confirm("Discard the changes to the current policy?"))
                    return;
                  dispatch({ type: "replace", editing: FRESH, notice: undefined });
                }}
              >
                <FilePlusIcon />
                New
              </Button>
              {onFleet ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={reload}>
                  <RefreshCwIcon />
                  {fleet.mode === "failed" ? "Retry" : "Reload"}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void open()}>
                <FolderOpenIcon />
                Open
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPasteOpen(true)}>
                <ClipboardPasteIcon />
                Paste
              </Button>
              <Button size="sm" variant="ghost" onClick={() => download(editing.name, text)}>
                <DownloadIcon />
                Download
              </Button>
              <Button size="sm" disabled={!canSave} onClick={save}>
                <SaveIcon />
                {onFleet || editing.handle ? "Save" : "Save as…"}
              </Button>
            </div>
          </div>
        </header>

        <div
          inert={fleet.mode === "loading"}
          className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pt-6 pb-24 sm:px-6"
        >
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
