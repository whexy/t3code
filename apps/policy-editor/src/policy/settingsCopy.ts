// Copied from the web app's Settings page (apps/web/src/components/settings), in its order.
// A path missing here still shows, under "Other settings", with a control from its schema.

export interface SettingCopyOption {
  readonly value: string | null;
  readonly label: string;
  readonly description?: string;
}

export interface SettingCopy {
  readonly path: string;
  readonly section: string;
  readonly group: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly control: "switch" | "select" | "number" | "text" | "textarea" | "json";
  readonly options?: ReadonlyArray<SettingCopyOption>;
  readonly unit?: string;
  /** Stored units per unit shown, such as 1000 for milliseconds shown as seconds. */
  readonly scale?: number;
  readonly min?: number;
  /** What a field that can be off becomes when switched on. */
  readonly enabledValue?: number;
  readonly max?: number;
}

export const SETTINGS_SECTIONS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "/settings/providers", label: "Providers" },
  { id: "/settings/threads", label: "Threads" },
  { id: "/settings/browser", label: "Browser" },
  { id: "/settings/devices", label: "Devices" },
  { id: "/settings/projects", label: "Projects" },
  { id: "/settings/source-control", label: "Source control" },
  { id: "/settings/worktrees", label: "Worktrees" },
  { id: "/settings/access", label: "Sharing & access" },
  { id: "/settings/secrets", label: "Secrets" },
  { id: "/settings/maintenance", label: "Maintenance" },
  { id: "/settings/labs", label: "Labs" },
];

export const SETTINGS_COPY: ReadonlyArray<SettingCopy> = [
  {
    path: "providerInstances",
    section: "/settings/providers",
    group: "Providers",
    title: "Providers",
    description: null,
    control: "json",
  },
  {
    path: "favorites",
    section: "/settings/providers",
    group: "Models",
    title: "Favorite models",
    description: "Models starred in the model picker, shared across connected devices.",
    control: "json",
  },
  {
    path: "providerModelPreferences",
    section: "/settings/providers",
    group: "Models",
    title: "Model list per provider",
    description: "Which of each provider's models are hidden, and their order in the model picker.",
    control: "json",
  },
  {
    path: "usageLimitSources",
    section: "/settings/providers",
    group: "Usage providers",
    title: "Usage providers",
    description: null,
    control: "json",
  },
  {
    path: "backgroundActivity.overrides.providerHealthRefreshInterval",
    section: "/settings/providers",
    group: "Advanced",
    title: "Health check interval",
    description:
      "Refresh provider status, versions, and models in the background. Set to 0 to disable.",
    control: "number",
    unit: "seconds",
    scale: 1000,
    min: 0,
  },
  {
    path: "idleCompaction",
    section: "/settings/providers",
    group: "Advanced",
    title: "Compact idle threads",
    description:
      "When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this.",
    control: "select",
    options: [
      { value: "onReturn", label: "When you return" },
      { value: "beforeCacheExpires", label: "Before the cache expires (beta)" },
      { value: "off", label: "Never" },
    ],
  },
  {
    path: "addProjectBaseDirectory",
    section: "/settings/threads",
    group: "New projects",
    title: "Add project starts in",
    description: 'Leave empty to use "~/" when the Add Project browser opens.',
    control: "text",
  },
  {
    path: "defaultModelSelection",
    section: "/settings/threads",
    group: "New threads",
    title: "Model",
    description: "Default model for new threads. Projects can override it.",
    control: "json",
  },
  {
    path: "fallbackModelSelection",
    section: "/settings/threads",
    group: "New threads",
    title: "Fallback model",
    description: "Used for new threads when the default model's provider is out of usage.",
    control: "json",
  },
  {
    path: "defaultRuntimeMode",
    section: "/settings/threads",
    group: "New threads",
    title: "Permissions",
    description: "Default permissions for new threads. Projects can override them.",
    control: "select",
    options: [
      {
        value: "approval-required",
        label: "Supervised",
        description: "Ask before commands and file changes.",
      },
      {
        value: "auto-accept-edits",
        label: "Auto-accept edits",
        description: "Auto-approve edits, ask before other actions.",
      },
      {
        value: "auto",
        label: "Auto",
        description: "Supported providers approve routine actions; others still ask.",
      },
      {
        value: "full-access",
        label: "Full access",
        description: "Allow commands and edits without prompts.",
      },
    ],
  },
  {
    path: "defaultThreadEnvMode",
    section: "/settings/threads",
    group: "New threads",
    title: "Workspace",
    description: "Where new threads start. Projects and their t3.json can override it.",
    control: "select",
    options: [
      { value: "local", label: "Current checkout" },
      { value: "worktree", label: "New worktree" },
    ],
  },
  {
    path: "snoozePresets",
    section: "/settings/threads",
    group: "Snooze",
    title: "Snooze options",
    description:
      "Choices in every snooze menu, listed soonest first. Weekdays mean the next one after today.",
    control: "json",
  },
  {
    path: "autoResumeLimitedThreads",
    section: "/settings/threads",
    group: "Usage limits",
    title: "Resume after usage limits",
    description:
      "Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.",
    control: "switch",
  },
  {
    path: "snoozeLimitedThreads",
    section: "/settings/threads",
    group: "Usage limits",
    title: "Snooze until limits reset",
    description:
      "Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset.",
    control: "switch",
  },
  {
    path: "sidebarAutoSettleOnMerge",
    section: "/settings/threads",
    group: "Auto-settle",
    title: "Auto-settle merged threads",
    description:
      "Settle a thread when its pull request merges. Closed pull requests still settle automatically.",
    control: "switch",
  },
  {
    path: "sidebarAutoSettleAfterDays",
    section: "/settings/threads",
    group: "Auto-settle",
    title: "Auto-settle inactive threads",
    description: "Sidebar threads with no activity for this long settle automatically.",
    control: "number",
    unit: "days",
    min: 1,
    max: 90,
  },
  {
    path: "sidebarAutoSettleKeepPullRequests",
    section: "/settings/threads",
    group: "Auto-settle",
    title: "Keep threads with a PR",
    description:
      "Inactivity does not settle threads with a pull request. Merge and close still do.",
    control: "switch",
  },
  {
    path: "textGenerationModelSelection",
    section: "/settings/threads",
    group: "Text generation",
    title: "Text generation model",
    description:
      "Used for thread titles and other generated text on connected devices with this provider. Source control can override it.",
    control: "json",
  },
  {
    path: "threadTitleInstructions",
    section: "/settings/threads",
    group: "Text generation",
    title: "Thread title instructions",
    description: "Appended to the prompt for new and regenerated thread titles.",
    control: "textarea",
  },
  {
    path: "responseStreamingMode",
    section: "/settings/threads",
    group: "Text generation",
    title: "Response streaming",
    description: "Each paragraph or code block appears as soon as it is complete.",
    control: "select",
    options: [
      {
        value: "turn",
        label: "Wait for the full response",
        description: "Text appears once the agent finishes its turn.",
      },
      {
        value: "paragraph",
        label: "Show finished paragraphs",
        description: "Each paragraph or code block appears as soon as it is complete.",
      },
    ],
  },
  {
    path: "enableAgentBrowserAccess",
    section: "/settings/browser",
    group: "Agent access",
    title: "Agent browser access",
    description: "Allow agents to use the shared browser. Projects can override it.",
    control: "switch",
  },
  {
    path: "enableDeviceSupport",
    section: "/settings/devices",
    group: "Devices",
    title: "Use devices",
    description: "Open simulators and emulators in the Device panel.",
    control: "switch",
  },
  {
    path: "enableAgentDeviceAccess",
    section: "/settings/devices",
    group: "Devices",
    title: "Agents can use devices",
    description: "New agent sessions can open and drive these devices.",
    control: "switch",
  },
  {
    path: "deviceHosts",
    section: "/settings/devices",
    group: "Device sources",
    title: "Machine over SSH",
    description: null,
    control: "json",
  },
  {
    path: "easDeviceHosts",
    section: "/settings/devices",
    group: "Device sources",
    title: "EAS Simulator",
    description: null,
    control: "json",
  },
  {
    path: "simlockDeviceHosts",
    section: "/settings/devices",
    group: "Device sources",
    title: "Simlock pool (alpha)",
    description: null,
    control: "json",
  },
  {
    path: "defaultProjectScripts",
    section: "/settings/projects",
    group: "Actions",
    title: "Actions",
    description:
      "Commands that run in this project's checkout or its worktree, with optional shortcuts.",
    control: "json",
  },
  {
    path: "defaultAutoPull",
    section: "/settings/source-control",
    group: "Repositories",
    title: "Automatically pull",
    description:
      "Keeps the default branch current when the checkout has no local changes or commits. Projects can override it.",
    control: "switch",
  },
  {
    path: "removeAgentCreditsOnMerge",
    section: "/settings/source-control",
    group: "Repositories",
    title: "Remove agent credits when merging",
    description:
      "Remove recognized agent credit lines from merge and squash messages on hosts that support it, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits.",
    control: "switch",
  },
  {
    path: "pullRequestMergeMethod",
    section: "/settings/source-control",
    group: "Repositories",
    title: "Default merge method",
    description:
      "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device.",
    control: "select",
    options: [
      { value: null, label: "Last selected" },
      { value: "merge", label: "Merge" },
      { value: "squash", label: "Squash and merge" },
      { value: "rebase", label: "Rebase and merge" },
    ],
  },
  {
    path: "sourceControlHosts",
    section: "/settings/source-control",
    group: "Source control providers",
    title: "Host credentials",
    description: null,
    control: "json",
  },
  {
    path: "sourceControlWritingStyle.mode",
    section: "/settings/source-control",
    group: "Writing & review",
    title: "Source control writing style",
    description: "In each project, matches recent change descriptions and change request titles.",
    control: "select",
    options: [
      {
        value: "repo_conventions",
        label: "Repository conventions",
        description:
          "In each project, matches recent change descriptions and change request titles.",
      },
      {
        value: "conventional_commits",
        label: "Conventional Commits",
        description: "Use Conventional Commit prefixes and keep change request text concise.",
      },
      {
        value: "custom",
        label: "Custom instructions",
        description:
          "Use your instructions for change descriptions and change requests in every project.",
      },
    ],
  },
  {
    path: "sourceControlWritingStyle.customInstructions",
    section: "/settings/source-control",
    group: "Writing & review",
    title: "Custom writing instructions",
    description:
      "Your instructions for change descriptions and change requests in every project, used when the writing style is set to custom.",
    control: "textarea",
  },
  {
    path: "reviewGuidesEnabled",
    section: "/settings/source-control",
    group: "Writing & review",
    title: "Review guides (beta)",
    description:
      "Add a Guide tab to pull requests. An agent explains the changes and points out decisions that need review.",
    control: "switch",
  },
  {
    path: "reviewGuideModelSelection",
    section: "/settings/source-control",
    group: "Writing & review",
    title: "Review guide model",
    description:
      "Model that reads a pull request to write its review guide. It reads the change itself over many steps, so a stronger model helps. Off uses the source control writer model.",
    control: "json",
  },
  {
    path: "reviewGuideInstructions",
    section: "/settings/source-control",
    group: "Writing & review",
    title: "Review guide instructions",
    description:
      "Your preferences for review guides: what to show first, dwell on, or skip. The guide's format and coverage stay the same.",
    control: "textarea",
  },
  {
    path: "sourceControlWritingStyle.followChangeRequestTemplates",
    section: "/settings/source-control",
    group: "Writing & review",
    title: "Follow change request templates",
    description: "Use the repository's template for change request descriptions when available.",
    control: "switch",
  },
  {
    path: "sourceControlWriterModelSelection",
    section: "/settings/source-control",
    group: "Writing & review",
    title: "Source control writer model",
    description:
      "Model for source control text and branch or bookmark names. When disabled, use the text generation model configured for this environment.",
    control: "json",
  },
  {
    path: "worktreesDirectory",
    section: "/settings/worktrees",
    group: "Creation",
    title: "Worktree location",
    description:
      "Folder where new worktrees are created, on any drive, such as D:\\worktrees or ~/worktrees. Existing worktrees stay where they are. Leave empty to use the T3 home folder.",
    control: "text",
  },
  {
    path: "newWorktreesStartFromOrigin",
    section: "/settings/worktrees",
    group: "Creation",
    title: "Start from remote",
    description:
      "Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing.",
    control: "switch",
  },
  {
    path: "worktreeSubmodules",
    section: "/settings/worktrees",
    group: "Creation",
    title: "Submodules",
    description:
      "How new worktrees populate git submodules. Projects and their t3.json can override it.",
    control: "select",
    options: [
      { value: null, label: "From t3.json, else recursive" },
      { value: "recursive", label: "Recursive" },
      { value: "top-level", label: "Top level only" },
      { value: "none", label: "Skip" },
    ],
  },
  {
    path: "branchNamingMode",
    section: "/settings/worktrees",
    group: "Branches",
    title: "Worktree branch naming",
    description: "Choose how new worktree branches are named from your first message.",
    control: "select",
    options: [
      { value: "static", label: "Static prefix" },
      { value: "semantic", label: "Semantic prefix" },
      { value: "custom", label: "Custom instructions" },
    ],
  },
  {
    path: "branchNamePrefix",
    section: "/settings/worktrees",
    group: "Branches",
    title: "Branch prefix",
    description: "For example, t3 or t3/ produces t3/add-search. Leave empty for no prefix.",
    control: "text",
  },
  {
    path: "branchNameInstructions",
    section: "/settings/worktrees",
    group: "Branches",
    title: "Branch naming instructions",
    description:
      "Appended to the naming prompt. The model returns the complete branch name; no prefix or suffix is added.",
    control: "textarea",
  },
  {
    path: "worktreeCleanup",
    section: "/settings/worktrees",
    group: "Cleanup",
    title: "Automatic worktree cleanup",
    description: "Use each machine's worktree cleanup settings.",
    control: "json",
  },
  {
    path: "storageCleanup.worktreeOnDelete",
    section: "/settings/worktrees",
    group: "Cleanup",
    title: "Delete worktrees with deleted threads",
    description:
      "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
    control: "switch",
  },
  {
    path: "storageCleanup.worktreeOnMerge",
    section: "/settings/worktrees",
    group: "Cleanup",
    title: "Delete merged worktrees",
    description:
      "Remove worktrees whose pull request is merged and whose commits are included in the default branch.",
    control: "switch",
  },
  {
    path: "storageCleanup.worktreeAfterDays",
    section: "/settings/worktrees",
    group: "Cleanup",
    title: "Delete inactive worktrees",
    description:
      "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
    control: "number",
    enabledValue: 8,
    unit: "days",
    min: 1,
    max: 3650,
  },
  {
    path: "storageCleanup.worktreeSettledAfterDays",
    section: "/settings/worktrees",
    group: "Cleanup",
    title: "Delete settled worktrees",
    description:
      "Remove worktrees this many days after their thread settles. Set 0 days to remove them at the next cleanup. Branches and thread history are kept.",
    control: "number",
    enabledValue: 8,
    unit: "days",
    min: 0,
    max: 3650,
  },
  {
    path: "storageCleanup.worktreeUnchanged",
    section: "/settings/worktrees",
    group: "Cleanup",
    title: "Delete unchanged worktrees",
    description: "Remove worktrees with no commits beyond the default branch.",
    control: "switch",
  },
  {
    path: "storageCleanup.worktreeKeepWhen",
    section: "/settings/worktrees",
    group: "Cleanup",
    title: "Keep worktrees with local changes",
    description: "Keeps edits and untracked files. Deletes ignored files, including .env.",
    control: "select",
    options: [
      {
        value: "any-local-files",
        label: "Any local files",
        description: "Includes ignored files, except node_modules.",
      },
      {
        value: "uncommitted-changes",
        label: "Uncommitted changes",
        description: "Keeps edits and untracked files. Deletes ignored files, including .env.",
      },
      {
        value: "tracked-changes",
        label: "Edited tracked files",
        description: "Deletes untracked and ignored files, including .env.",
      },
    ],
  },
  {
    path: "environmentIcon",
    section: "/settings/access",
    group: "This machine",
    title: "Environment icon",
    description: null,
    control: "select",
    options: [
      { value: null, label: "Detected (default)" },
      { value: "server", label: "Server" },
      { value: "cloud", label: "Cloud VM" },
      { value: "linux", label: "Linux/WSL" },
      { value: "desktop", label: "Desktop" },
      { value: "laptop", label: "Laptop" },
      { value: "mac-mini", label: "Mini PC" },
      { value: "mac-studio", label: "Workstation" },
    ],
  },
  {
    path: "secretProviders",
    section: "/settings/secrets",
    group: "Secret providers",
    title: "Secret providers",
    description: null,
    control: "json",
  },
  {
    path: "enableProviderUpdateChecks",
    section: "/settings/maintenance",
    group: "Updates",
    title: "Provider update checks",
    description:
      "Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear.",
    control: "switch",
  },
  {
    path: "continueThreadsAfterServerUpdate",
    section: "/settings/maintenance",
    group: "Updates",
    title: "Continue threads after restarts",
    description:
      "Automatically resume interrupted threads after an update, crash, or machine restart on the selected environments.",
    control: "switch",
  },
  {
    path: "backgroundActivity.profile",
    section: "/settings/maintenance",
    group: "Background activity",
    title: "Background activity",
    description: "Pauses probes for idle clients, locked hosts, or low power mode.",
    control: "select",
    options: [
      {
        value: "balanced",
        label: "Balanced",
        description: "Pauses probes for idle clients, locked hosts, or low power mode.",
      },
      {
        value: "performance",
        label: "Performance",
        description:
          "Allows scoped background probes while any subscribed client remains connected.",
      },
      {
        value: "battery-saver",
        label: "Battery saver",
        description: "Also pauses background probes when the host or client is on battery.",
      },
      {
        value: "custom",
        label: "Advanced",
        description: "Uses custom intervals. Shared policy: {baseProfileLabel}.",
      },
    ],
  },
  {
    path: "backgroundActivity.baseProfile",
    section: "/settings/maintenance",
    group: "Background activity",
    title: "Shared policy",
    description: "Controls whether background work may run after a subscribed interval fires.",
    control: "select",
    options: [
      { value: "balanced", label: "Balanced" },
      { value: "performance", label: "Performance" },
      { value: "battery-saver", label: "Battery saver" },
    ],
  },
  {
    path: "backgroundActivity.overrides.automaticGitFetchInterval",
    section: "/settings/maintenance",
    group: "Background activity",
    title: "Git fetch interval",
    description: "Refresh remote branch status in the background.",
    control: "number",
    unit: "seconds",
    scale: 1000,
    min: 0,
  },
  {
    path: "backgroundActivity.overrides.hostPowerMonitorActiveInterval",
    section: "/settings/maintenance",
    group: "Background activity",
    title: "Host power monitor",
    description: "Poll host power state while clients are active.",
    control: "number",
    unit: "seconds",
    scale: 1000,
    min: 5,
  },
  {
    path: "backgroundActivity.overrides.hostPowerMonitorIdleInterval",
    section: "/settings/maintenance",
    group: "Background activity",
    title: "Idle host monitor",
    description: "Poll host power state when no foreground client is active.",
    control: "number",
    unit: "seconds",
    scale: 1000,
    min: 5,
  },
  {
    path: "backgroundActivity.overrides.pauseWhenHostLocked",
    section: "/settings/maintenance",
    group: "Background activity",
    title: "Pause when host is locked",
    description: null,
    control: "switch",
  },
  {
    path: "backgroundActivity.overrides.pauseWhenHostLowPower",
    section: "/settings/maintenance",
    group: "Background activity",
    title: "Pause on host low power",
    description: null,
    control: "switch",
  },
  {
    path: "backgroundActivity.overrides.pauseWhenClientLowPower",
    section: "/settings/maintenance",
    group: "Background activity",
    title: "Pause on client low power",
    description: null,
    control: "switch",
  },
  {
    path: "backgroundActivity.overrides.pauseWhenOnBattery",
    section: "/settings/maintenance",
    group: "Background activity",
    title: "Pause on battery",
    description: null,
    control: "switch",
  },
  {
    path: "storageCleanup.browserArtifactsAfterDays",
    section: "/settings/maintenance",
    group: "Artifacts and logs",
    title: "Delete old browser artifacts",
    description:
      "Delete saved browser captures after this many days. Older capture links will no longer open.",
    control: "number",
    enabledValue: 8,
    unit: "days",
    min: 1,
    max: 3650,
  },
  {
    path: "storageCleanup.logsAfterDays",
    section: "/settings/maintenance",
    group: "Artifacts and logs",
    title: "Delete old rotated logs",
    description: "Delete inactive rotated log files after this many days. Current logs are kept.",
    control: "number",
    enabledValue: 8,
    unit: "days",
    min: 1,
    max: 3650,
  },
  {
    path: "guestSharingEnabled",
    section: "/settings/labs",
    group: "Beta",
    title: "Guest links",
    description:
      "Share a thread with a guest who watches it live in their browser and sends messages you approve. Needs T3 Connect: sign in and link this machine in Sharing & access. While it is off, every guest link stops working.",
    control: "switch",
  },
  {
    path: "linkedEnvironmentsEnabled",
    section: "/settings/labs",
    group: "Beta",
    title: "Linked environments",
    description:
      "Let agents here work on your other machines, and theirs here. Turn it on for each machine, then link them in Connections. While it is off, nothing new starts over a link; tasks already running finish.",
    control: "switch",
  },
  {
    path: "simlockDeviceHostsEnabled",
    section: "/settings/labs",
    group: "Beta",
    title: "Simlock device hosts (alpha)",
    description:
      "Let the Device panel lease simulators and emulators from your own Simlock pool, added in Devices. An alpha that may change or break. T3 Code never installs Simlock.",
    control: "switch",
  },
];
