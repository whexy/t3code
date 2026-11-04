import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  ClipboardPasteIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FilePlusIcon,
  FlaskConicalIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitForkIcon,
  GlobeIcon,
  KeyRoundIcon,
  type LucideIcon,
  MessagesSquareIcon,
  PanelsTopLeftIcon,
  RefreshCwIcon,
  SaveIcon,
  Settings2Icon,
  ShieldCheckIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  Trash2Icon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import {
  Fragment,
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
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
import {
  deletePolicy,
  listPolicies,
  type Opened,
  openPolicies,
  POLICY_NAME,
  savePolicy,
  sha12,
} from "./policy/remote.ts";
import {
  afterRemoteSave,
  FRESH,
  type Fleet,
  INITIAL_SESSION,
  isDirty,
  type Notice,
  pickerNames,
  sessionReducer,
  type SessionAction,
  textOf,
} from "./policy/session.ts";
import { type Problem, type ProblemTarget, validatePolicy } from "./policy/validate.ts";
import { JsonEditor, ProblemList } from "./ui/controls.tsx";
import { Dialog } from "./ui/dialog.tsx";
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
  "/settings/access": UsersIcon,
  "/settings/secrets": KeyRoundIcon,
  "/settings/maintenance": WrenchIcon,
  "/settings/labs": FlaskConicalIcon,
  other: Settings2Icon,
};

const sectionAnchor = (id: string) => `section:${id}`;
const NAV_IDS = ["policy", "limits", ...SETTING_SECTIONS.map((section) => section.id)];

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

const DISCARD = (name: string) => `Discard the unsaved changes to ${name}?`;

const openTask =
  (name: string | undefined, notice?: Notice) => async (): Promise<SessionAction> => ({
    type: "opened",
    ...(await openPolicies(name)),
    ...(notice === undefined ? {} : { notice }),
  });

/** The open policy's saved version, if any, and what is known about it. */
function fleetStatus(
  fleet: Fleet,
): { readonly version?: string; readonly text: string } | undefined {
  switch (fleet.mode) {
    case "files":
      return undefined;
    case "loading":
      return { text: "loading…" };
    case "failed":
      return { text: "not loaded" };
    case "ready": {
      const { target } = fleet;
      if (target === undefined || target.etag === null) return { text: "not saved yet" };
      const savedAt = target.savedAt?.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
      return {
        version: sha12(target.etag),
        text: target.unreadable ? "cannot be opened" : `saved ${savedAt ?? ""}`,
      };
    }
  }
}

function fleetCaption(fleet: Fleet): string {
  switch (fleet.mode) {
    case "files":
      return "Policies in this browser";
    case "loading":
      return "Loading policies…";
    case "failed":
      return "Policies not loaded";
    case "ready":
      return `${fleet.policies.length} published ${fleet.policies.length === 1 ? "policy" : "policies"}`;
  }
}

/** New starts a draft; Fork and a first Save store the current policy under a new name. */
type Naming = "new" | "fork";

export function App({ initialOpen }: { readonly initialOpen: Promise<Opened> }) {
  const [session, dispatch] = useReducer(sessionReducer, INITIAL_SESSION);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [naming, setNaming] = useState<Naming | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState("policy");
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
  const ready = fleet.mode === "ready" ? fleet : undefined;
  const target = ready?.target;
  const targetName = target?.name;
  const publicUrl =
    target?.etag === null
      ? undefined
      : ready?.policies.find((summary) => summary.name === targetName)?.publicUrl;
  const canSave = !busy && fleet.mode !== "loading" && fleet.mode !== "failed";
  const currentLabel = targetName ?? "this policy";
  const status = fleetStatus(fleet);

  const edit = (segments: ReadonlyArray<string>, value: unknown) =>
    dispatch({ type: "edit", segments, value });
  const setSetting = (key: string, entry: { value: unknown; locked: boolean } | undefined) =>
    edit(["settings", key], entry);

  /**
   * Runs one load or save at a time; the task's action ends it. `replacing` tasks load over what
   * is being edited, so the editor takes no edits until they settle.
   */
  const run = (task: () => Promise<SessionAction>, replacing: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    dispatch({ type: "begin", replacing });
    void task()
      .catch((error: unknown): SessionAction => ({
        type: "settled",
        notice: {
          tone: "error",
          text: `The request failed: ${error instanceof Error ? error.message : String(error)}`,
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
    void initialOpen.then((opened) => {
      if (!current) return;
      inFlight.current = false;
      dispatch({ type: "opened", ...opened });
    });
    return () => {
      current = false;
    };
  }, [initialOpen]);

  // Keeps the address bar naming the open policy, so a page reload reopens it.
  useEffect(() => {
    if (targetName === undefined || target?.etag === null) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("policy") === targetName) return;
    url.searchParams.set("policy", targetName);
    window.history.replaceState(null, "", url);
  }, [targetName, target?.etag]);

  const confirmDiscard = () => !dirty || window.confirm(DISCARD(currentLabel));
  const confirmInvalid = () =>
    verdict.valid || window.confirm("t3 policy check refuses this policy. Save it anyway?");

  const load = (file: OpenedFile) => {
    if (inFlight.current) return;
    const read = readPolicyText(file.text);
    if (!read.ok) {
      return dispatch({
        type: "notice",
        notice: { tone: "error", text: `${file.name}: ${read.message}` },
      });
    }
    if (!confirmDiscard()) return;
    dispatch({
      type: "import",
      file: { name: file.name, text: file.text, handle: file.handle },
      document: read.document,
      notice: {
        tone: "info",
        text: onFleet
          ? target === undefined
            ? `Opened ${file.name}. Save names and publishes it.`
            : `Opened ${file.name} into ${target.name}. Save replaces ${target.name} with it.`
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
    if (inFlight.current || !confirmDiscard()) return;
    run(openTask(targetName), true);
  };

  const switchTo = (name: string) => {
    if (name === targetName || inFlight.current || !confirmDiscard()) return;
    run(openTask(name), true);
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

  const saveTask =
    (submitted: OpenedText, name: string, etag: string | null) =>
    async (): Promise<SessionAction> => {
      const result = await savePolicy(name, submitted.text, etag);
      const list = result.status === "saved" ? await listPolicies({ dev: false }) : undefined;
      return afterRemoteSave(
        submitted,
        name,
        etag,
        result,
        list?.status === "listed" ? list.policies : undefined,
      );
    };

  const save = () => {
    if (inFlight.current || !canSave || !confirmInvalid()) return;
    const submitted: OpenedText = { text, document: policy };
    if (ready === undefined) return run(() => saveFile(submitted), false);
    if (target === undefined) return setNaming("fork");
    if (
      target.unreadable &&
      !window.confirm(
        `The saved ${target.name} (${sha12(target.etag ?? "")}) cannot be opened. Replace it with this policy?`,
      )
    )
      return;
    run(saveTask(submitted, target.name, target.etag), false);
  };

  const fork = (name: string) => {
    setNaming(undefined);
    if (inFlight.current || !confirmInvalid()) return;
    run(saveTask({ text, document: policy }, name, null), false);
  };

  const startDraft = (name: string) => {
    setNaming(undefined);
    if (!confirmDiscard()) return;
    dispatch({ type: "draft", name });
  };

  const newFile = () => {
    if (!confirmDiscard()) return;
    dispatch({ type: "replace", editing: FRESH, notice: undefined });
  };

  const remove = () => {
    if (inFlight.current || target === undefined) return;
    if (target.etag === null) {
      if (confirmDiscard()) run(openTask(undefined), true);
      return;
    }
    const { name, etag } = target;
    if (
      !window.confirm(
        `Delete ${name}? Hosts following it keep their last good copy and raise an alert.${dirty ? " Your unsaved changes are lost too." : ""}`,
      )
    )
      return;
    run(async () => {
      const result = await deletePolicy(name, etag);
      if (result.status === "deleted") {
        return openTask(undefined, { tone: "info", text: `Deleted ${name}.` })();
      }
      return {
        type: "settled",
        notice: {
          tone: "error",
          text:
            result.status === "conflict"
              ? `${name} changed elsewhere since you loaded it, so it was not deleted. Reload to see the current version.`
              : `Could not delete ${name}: ${result.message}`,
        },
      };
    }, true);
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

  // Marks the section at the top of the scroller in the sidebar.
  useEffect(() => {
    const root = scroller.current;
    if (root === null) return;
    const update = () => {
      const line = root.getBoundingClientRect().top + 96;
      const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      let current = "policy";
      for (const id of NAV_IDS) {
        const top = document.getElementById(sectionAnchor(id))?.getBoundingClientRect().top;
        if (top !== undefined && (top <= line || atEnd)) current = id;
      }
      setActiveSection(current);
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    return () => root.removeEventListener("scroll", update);
  }, []);

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

  const fileActions = (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="icon" aria-label="More actions" />}>
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem
          disabled={busy || fleet.mode === "loading" || fleet.mode === "failed"}
          onClick={() => (ready === undefined ? newFile() : setNaming("new"))}
        >
          <FilePlusIcon />
          New policy…
        </MenuItem>
        {ready === undefined ? null : (
          <MenuItem disabled={busy} onClick={() => setNaming("fork")}>
            <GitForkIcon />
            Fork…
          </MenuItem>
        )}
        <MenuItem disabled={busy} onClick={() => void open()}>
          <FolderOpenIcon />
          Open file…
        </MenuItem>
        <MenuItem disabled={busy} onClick={() => setPasteOpen(true)}>
          <ClipboardPasteIcon />
          Paste JSON…
        </MenuItem>
        <MenuItem onClick={() => download(editing.name, text)}>
          <DownloadIcon />
          Download
        </MenuItem>
        {onFleet ? (
          <MenuItem disabled={busy} onClick={reload}>
            <RefreshCwIcon />
            {fleet.mode === "failed" ? "Retry" : "Reload"}
          </MenuItem>
        ) : null}
        {ready === undefined ? null : (
          <>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={busy || target === undefined}
              onClick={remove}
            >
              <Trash2Icon />
              Delete…
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );

  return (
    <div
      ref={scroller}
      // The web stylesheet locks body and #root scrolling, so the editor scrolls this element.
      className="relative h-dvh overflow-y-auto bg-canvas font-sans text-ink scrollbar-gutter-both"
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
        <div className="glass-card pointer-events-none fixed inset-3 z-50 flex items-center justify-center font-title text-sm font-medium text-ink-glass">
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

      <div className="flex flex-col gap-4 sm:p-4 lg:flex-row lg:items-start lg:justify-center lg:gap-6 lg:py-0">
        <aside className="mx-auto w-full max-w-content lg:sticky lg:top-0 lg:mx-0 lg:max-h-dvh lg:w-64 lg:shrink-0 lg:overflow-y-auto lg:px-1 lg:py-10">
          <div className="glass-card p-4 max-sm:rounded-none">
            <div className="glass-tint from-blue-100/30 via-purple-50/20 to-pink-100/30" />
            <div className="glow-blob top-4 left-4 h-24 w-24 from-blue-200/20 to-cyan-200/20 blur-xl" />
            <div className="glow-blob right-6 bottom-4 h-20 w-20 from-purple-200/15 to-pink-200/15 blur-lg" />
            <div className="glow-blob top-32 right-4 h-16 w-16 from-yellow-200/15 to-orange-200/15 blur-lg" />
            <div className="glass-shine" />
            <div className="relative z-10 flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink text-on-ink">
                  <ShieldCheckIcon className="size-4.5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <div className="font-title text-xl leading-tight font-semibold tracking-tight text-black">
                    Policy editor
                  </div>
                  <p className="truncate text-xs text-ink-muted">{fleetCaption(fleet)}</p>
                </div>
              </div>
              <div className="space-y-2">
                {ready === undefined ? null : (
                  <PolicyPicker
                    names={pickerNames(fleet)}
                    value={targetName}
                    disabled={busy}
                    onChange={switchTo}
                  />
                )}
                {publicUrl === undefined ? null : <PublicUrl url={publicUrl} />}
              </div>
              <div className="flex items-center gap-2">
                <Button className="flex-1" disabled={!canSave} onClick={save}>
                  <SaveIcon />
                  {onFleet
                    ? target === undefined
                      ? "Save as…"
                      : "Save"
                    : editing.handle
                      ? "Save"
                      : "Save as…"}
                </Button>
                {fileActions}
              </div>
              <nav aria-label="Sections" className="segmented w-full overflow-x-auto lg:hidden">
                {nav.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={item.id === activeSection ? "true" : undefined}
                    onClick={() => scrollTo(sectionAnchor(item.id))}
                    className={`segmented-item ${item.id === activeSection ? "segmented-active" : "segmented-idle"}`}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>
              <nav
                aria-label="Sections"
                className="hidden flex-col gap-0.5 border-t border-black/5 pt-3 lg:flex"
              >
                {nav.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={item.id === activeSection ? "true" : undefined}
                    onClick={() => scrollTo(sectionAnchor(item.id))}
                    className={item.id === activeSection ? "tab tab-active" : "tab"}
                  >
                    <span className="tab-badge">
                      <item.icon className="size-3.5" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.count > 0 ? (
                      <span
                        className="flex items-center gap-1 text-xs font-normal text-ink"
                        aria-label={plural(item.count, "problem")}
                      >
                        <CircleAlertIcon className="size-3.5" aria-hidden />
                        {item.count}
                      </span>
                    ) : null}
                  </button>
                ))}
              </nav>
            </div>
          </div>
        </aside>

        <main
          inert={fleet.mode === "loading" || session.replacing}
          className="mx-auto w-full max-w-content min-w-0 space-y-6 pb-24 lg:mx-0 lg:pt-10"
        >
          <header className="space-y-1 px-4 pt-2 sm:px-2 lg:pt-0">
            <div className="flex items-baseline gap-3">
              <h1 className="font-title text-xl font-bold tracking-tight">
                {onFleet ? (targetName ?? "New policy") : editing.name}
              </h1>
              {dirty ? <span className="text-sm font-medium text-ink">Unsaved</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
              {status === undefined ? null : (
                <>
                  {status.version === undefined ? null : (
                    <>
                      <code className="font-mono">{status.version}</code>
                      <span aria-hidden>·</span>
                    </>
                  )}
                  <span>{status.text}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              {verdict.problems.length === 0 ? (
                <span className="flex items-center gap-1">
                  <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
                  {summaryLine(false, 0, 0)}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => scrollTo("problems")}
                  className="flex items-center gap-1 text-left text-ink transition-colors duration-150 hover:text-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden />
                  {summaryLine(verdict.serverReason !== undefined, errors.length, warnings.length)}
                </button>
              )}
            </div>
          </header>

          {notice ? (
            <div
              role="status"
              className="glass-card flex items-start gap-2 px-4 py-3 text-sm max-sm:rounded-none sm:rounded-2xl"
            >
              {notice.tone === "error" ? (
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-ink" aria-label="Error" />
              ) : null}
              <span className={notice.tone === "error" ? "text-ink" : "text-ink-subtle"}>
                {notice.text}
              </span>
            </div>
          ) : null}

          {verdict.problems.length === 0 ? null : (
            <section id="problems" className="panel scroll-mt-10 px-4 py-6 sm:px-8 sm:py-8">
              <h2 className="pb-2 font-title text-lg font-semibold tracking-tight">
                {errors.length > 0 ? "Problems" : "Warnings"}
              </h2>
              <ul className="space-y-1.5">
                {verdict.problems.map((problem) => (
                  <li
                    key={`${JSON.stringify(problem.target)}${problem.message}`}
                    className="text-sm"
                  >
                    <button
                      type="button"
                      onClick={() => scrollTo(anchorFor(problem.target))}
                      className={`text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${problem.severity === "error" ? "text-ink" : "text-ink-subtle"}`}
                    >
                      <span className="font-medium">
                        {problem.severity === "error" ? "Refused " : "Warning "}
                      </span>
                      <code className="font-mono text-xs">{describeTarget(problem.target)}</code>:{" "}
                      {problem.message}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <SettingsSection
            id={sectionAnchor("policy")}
            title="Policy"
            description={
              <>
                Each setting can be left <strong className="font-medium text-ink">not set</strong>{" "}
                (the user's own value, or the built-in default), given a{" "}
                <strong className="font-medium text-ink">default</strong> users can change, or{" "}
                <strong className="font-medium text-ink">locked</strong>. Open or drop a policy file
                to edit it.
              </>
            }
          >
            <SettingsRow
              id="policy:organization"
              invalid={documentProblems("organization").length > 0}
              title="Organization"
              description='Shown to users in Settings and beside each control the policy locks, as "Managed by <organization>".'
              status={<code className="font-mono text-xs text-ink-muted">organization</code>}
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
              status={<code className="font-mono text-xs text-ink-muted">supportUrl</code>}
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
              status={<code className="font-mono text-xs text-ink-muted">schemaVersion</code>}
              control={
                record.schemaVersion === 1 ? (
                  <span className="px-3 text-sm text-ink-subtle">Version 1</span>
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
                title={<code className="font-mono">{key}</code>}
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
                  title={<code className="font-mono">{key}</code>}
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
                <Fragment key={row.path}>
                  {row.group !== null &&
                  row.group !== section.label &&
                  row.group !== section.rows[index - 1]?.group ? (
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
                </Fragment>
              ))}
            </SettingsSection>
          ))}

          <SettingsSection
            id="section:json"
            title="Policy JSON"
            description="What Save and Download write."
          >
            <pre className="code-field mt-2 mb-4 max-h-96 overflow-auto break-all whitespace-pre-wrap">
              {text}
            </pre>
          </SettingsSection>
        </main>
      </div>

      <PasteDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        onImport={(pasted) => {
          load({ name: FRESH.name, text: pasted });
          setPasteOpen(false);
        }}
      />
      <NameDialog
        naming={naming}
        taken={ready === undefined ? [] : pickerNames(ready)}
        from={targetName}
        onCancel={() => setNaming(undefined)}
        onSubmit={(name) => (naming === "new" ? startDraft(name) : fork(name))}
      />
    </div>
  );
}

function PolicyPicker({
  names,
  value,
  disabled,
  onChange,
}: {
  readonly names: ReadonlyArray<string>;
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (name: string) => void;
}) {
  return (
    <Select
      value={value ?? null}
      disabled={disabled || names.length === 0}
      onValueChange={(name) => {
        if (typeof name === "string") onChange(name);
      }}
    >
      <SelectTrigger aria-label="Policy">
        <SelectValue>{(name: string | null) => name ?? "No policy stored"}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {names.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function PublicUrl({ url }: { readonly url: string }) {
  const [copied, setCopied] = useState(false);
  const file = url.slice(url.lastIndexOf("/") + 1);
  return (
    <div className="flex items-center gap-1">
      {/* The host is the same for every policy and does not fit the card; copy carries the full URL. */}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Public URL: ${url}`}
        className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs text-ink-subtle transition-colors duration-150 hover:text-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <GlobeIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{file}</span>
      </a>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={copied ? "Copied" : "Copy the public URL"}
        onClick={() =>
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

function NameDialog({
  naming,
  taken,
  from,
  onCancel,
  onSubmit,
}: {
  readonly naming: Naming | undefined;
  readonly taken: ReadonlyArray<string>;
  /** The policy a fork copies; undefined when nothing is stored yet. */
  readonly from: string | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [shownFor, setShownFor] = useState<Naming | undefined>(undefined);
  if (shownFor !== naming) {
    setShownFor(naming);
    setName(naming === "fork" && from !== undefined ? `${from}-copy` : "");
  }
  const problem =
    name === ""
      ? undefined
      : !POLICY_NAME.test(name)
        ? "Use up to 63 lowercase letters, digits and hyphens, starting with a letter or digit."
        : name === "policy"
          ? "The name policy is reserved for the single-policy server's file."
          : taken.includes(name)
            ? `${name} already exists.`
            : undefined;
  const valid = name !== "" && problem === undefined;
  const title = naming === "new" ? "New policy" : from === undefined ? "Save as" : `Fork ${from}`;
  const description =
    naming === "new"
      ? "Starts an empty policy. Save creates it."
      : `Saves ${from === undefined ? "this policy" : `${from}, with any unsaved changes,`} under a new name.`;
  return (
    <Dialog open={naming !== undefined} onClose={onCancel} title={title} description={description}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onSubmit(name);
        }}
      >
        <div className="space-y-1.5">
          <Input
            aria-label="Policy name"
            placeholder="team-name"
            spellCheck={false}
            autoCapitalize="none"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value.trim())}
          />
          {problem === undefined ? null : <p className="text-xs text-ink">{problem}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid}>
            {naming === "new" ? "Create" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
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
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title="Paste a policy"
      description="Paste the policy's JSON to edit it here."
    >
      <div className="space-y-1.5">
        <Textarea
          aria-label="Policy JSON"
          className="font-mono"
          rows={12}
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {parsed !== undefined && !parsed.ok ? (
          <p className="text-xs text-ink">{parsed.message}</p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button disabled={parsed === undefined || !parsed.ok} onClick={() => onImport(text)}>
          Open
        </Button>
      </div>
    </Dialog>
  );
}
