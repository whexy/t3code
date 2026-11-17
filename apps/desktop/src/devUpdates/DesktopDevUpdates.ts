// @effect-diagnostics nodeBuiltinImport:off -- zlib inflates the bundle archive; Effect has no gzip codec.
import * as NodeZlib from "node:zlib";

import {
  DEV_UPDATES_CHANNEL,
  DEV_UPDATES_MANIFEST_URL,
  type DevUpdatesState,
} from "@t3tools/shared/devUpdates";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Electron from "electron";

import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as Channels from "./channels.ts";
import * as Protocol from "./protocol.ts";
import * as DevState from "./state.ts";

// app-update.yml names the GitHub feed CI baked from GITHUB_REPOSITORY. Only the fork's
// release lane builds against this repository, so only its builds follow the dev lane.
const FORK_UPDATE_FEED = { owner: "whexy", repo: "t3code" } as const;
const CERTIFICATE_RESOURCE = "forkOtaCertificate.pem";
const BUNDLE_DIRECTORY = "dev-updates";
const STATE_FILE = "state.json";
const BUNDLE_ENTRY = "index.html";
// Navigations replacing a load in flight report ERR_ABORTED; they are not failures.
const ERR_ABORTED = -3;

const { logInfo, logWarning } = makeComponentLogger("desktop-dev-updates");

const DevBundleSchema = Schema.Struct({
  updateId: Schema.String,
  commit: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
const DevUpdatesStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  runtimeVersion: Schema.String,
  running: Schema.NullOr(DevBundleSchema),
  pending: Schema.NullOr(DevBundleSchema),
});

export class DesktopDevUpdates extends Context.Service<
  DesktopDevUpdates,
  {
    /** Call once, before any window loads; the result names the directory to serve right now. */
    readonly launch: (embeddedAssetDirectory: string) => Effect.Effect<() => string>;
    readonly getState: Effect.Effect<DevUpdatesState>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<DevUpdatesState>;
  }
>()("@t3tools/desktop/devUpdates/DesktopDevUpdates") {}

/** The renderer asset directory to serve; the embedded one wherever the lane is not wired. */
export const assetDirectory = Effect.fn("DesktopDevUpdates.assetDirectory")(function* (
  embeddedAssetDirectory: string,
) {
  const devUpdates = yield* Effect.serviceOption(DesktopDevUpdates);
  return Option.isSome(devUpdates)
    ? yield* devUpdates.value.launch(embeddedAssetDirectory)
    : embeddedAssetDirectory;
});

function parseUpdateFeed(appUpdateYml: string): { owner: string; repo: string } | null {
  const value = (key: string) =>
    new RegExp(`^${key}:\\s*["']?([^"'\\s]+)["']?\\s*$`, "m").exec(appUpdateYml)?.[1];
  const owner = value("owner");
  const repo = value("repo");
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

const gunzip = (data: Uint8Array) =>
  Effect.callback<Uint8Array, Protocol.DevUpdateProtocolError>((resume) => {
    NodeZlib.gunzip(data, (error, result) =>
      resume(
        error === null
          ? Effect.succeed(result)
          : Effect.fail(new Protocol.DevUpdateProtocolError({ reason: "the bundle is not gzip" })),
      ),
    );
  });

const isProtocolError = Schema.is(Protocol.DevUpdateProtocolError);

const protocolStep = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      isProtocolError(cause)
        ? cause
        : new Protocol.DevUpdateProtocolError({ reason: String(cause) }),
  });

type BootPhase = "embedded" | "starting" | "started" | "failed";

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const path = environment.path;

  const isForkBuild =
    environment.isPackaged &&
    !environment.isDevelopment &&
    (yield* fileSystem.readFileString(environment.appUpdateYmlPath).pipe(
      Effect.map((text) => {
        const feed = parseUpdateFeed(text);
        return feed?.owner === FORK_UPDATE_FEED.owner && feed.repo === FORK_UPDATE_FEED.repo;
      }),
      Effect.orElseSucceed(() => false),
    ));

  yield* ipc.handleSync(
    DesktopIpc.makeSyncIpcMethod({
      channel: Channels.DEV_UPDATES_AVAILABLE_CHANNEL,
      result: Schema.Boolean,
      handler: () => Effect.succeed(isForkBuild),
    }),
  );
  if (!isForkBuild) {
    const unavailable = Effect.succeed(
      DevState.toBridgeState({
        state: DevState.EMPTY_STATE,
        running: null,
        appVersion: environment.appVersion,
      }),
    );
    return DesktopDevUpdates.of({
      launch: Effect.fn("DesktopDevUpdates.launch")((embeddedAssetDirectory: string) =>
        Effect.succeed(() => embeddedAssetDirectory),
      ),
      getState: unavailable,
      setEnabled: Effect.fn("DesktopDevUpdates.setEnabled")(() => unavailable),
    });
  }

  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const httpClient = yield* HttpClient.HttpClient;
  const layerScope = yield* Scope.Scope;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const appVersion = environment.appVersion;
  const appUrlPrefix = `${ElectronProtocol.getDesktopScheme(false)}:`;
  const directoryRef = yield* Ref.make(Option.none<string>());
  let embeddedDirectory = "";
  // Read synchronously by the protocol handler on every request.
  let servedDirectory = "";
  const stateRef = yield* SynchronizedRef.make(DevState.EMPTY_STATE);
  const runningRef = yield* Ref.make<DevState.StoredBundle | null>(null);
  const phaseRef = yield* Ref.make<BootPhase>("embedded");
  const checkLock = yield* Semaphore.make(1);

  const publicKey = yield* assets.resolveResourcePath(CERTIFICATE_RESOURCE).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (certificatePath) =>
          fileSystem.readFileString(certificatePath).pipe(
            Effect.flatMap((pem) => protocolStep(() => Protocol.publicKeyFromCertificate(pem))),
            Effect.asSome,
          ),
      }),
    ),
    Effect.catch((error) =>
      logWarning("could not load the OTA certificate", { error }).pipe(Effect.as(Option.none())),
    ),
  );

  const encodeState = Schema.encodeEffect(DevState.StoredStateJson);

  const readState = (directory: string) =>
    fileSystem.readFileString(path.join(directory, STATE_FILE)).pipe(
      Effect.flatMap(Schema.decodeEffect(DevState.StoredStateJson)),
      Effect.map(DevState.fromDocument),
      Effect.orElseSucceed(() => DevState.EMPTY_STATE),
    );

  const writeState = Effect.fn("DesktopDevUpdates.writeState")(function* (
    directory: string,
    state: DevState.StoredState,
  ) {
    const target = path.join(directory, STATE_FILE);
    const temporary = `${target}.tmp`;
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(temporary, yield* encodeState(state));
    yield* fileSystem.rename(temporary, target);
  });

  /** Applies f to the persisted state; memory follows only a successful write. */
  const updateState = (f: (state: DevState.StoredState) => DevState.StoredState) =>
    SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.gen(function* () {
        const directory = yield* Ref.get(directoryRef);
        const next = f(state);
        if (Option.isSome(directory)) yield* writeState(directory.value, next);
        return [next, next] as const;
      }),
    );

  const prune = Effect.fn("DesktopDevUpdates.prune")(function* (directory: string) {
    const keep = DevState.bundlesToKeep(
      yield* SynchronizedRef.get(stateRef),
      yield* Ref.get(runningRef),
    );
    const entries = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      if (entry === STATE_FILE || keep.has(entry)) continue;
      yield* fileSystem.remove(path.join(directory, entry), { recursive: true, force: true });
    }
  });

  const bridgeState = Effect.gen(function* () {
    return DevState.toBridgeState({
      state: yield* SynchronizedRef.get(stateRef),
      running: yield* Ref.get(runningRef),
      appVersion,
    });
  });

  const fetchManifest = Effect.fn("DesktopDevUpdates.fetchManifest")(function* (
    key: Option.Option<Protocol.PublicKey>,
  ) {
    if (Option.isNone(key)) {
      return yield* new Protocol.DevUpdateProtocolError({
        reason: "no certificate to verify with",
      });
    }
    const running = yield* Ref.get(runningRef);
    const request = HttpClientRequest.get(DEV_UPDATES_MANIFEST_URL).pipe(
      HttpClientRequest.accept("multipart/mixed"),
      HttpClientRequest.setHeaders({
        "expo-platform": "desktop",
        "expo-runtime-version": appVersion,
        "expo-channel-name": DEV_UPDATES_CHANNEL,
        "expo-protocol-version": "1",
        "expo-expect-signature": `sig, keyid="${Protocol.SIGNATURE_KEY_ID}", alg="${Protocol.SIGNATURE_ALGORITHM}"`,
        ...(running === null ? {} : { "expo-current-update-id": running.updateId }),
      }),
    );
    const response = yield* httpClient.execute(request);
    const body = new Uint8Array(yield* response.arrayBuffer);
    return yield* protocolStep(() =>
      Protocol.readManifestResponse({
        status: response.status,
        contentType: response.headers["content-type"],
        body,
        publicKey: key.value,
      }),
    );
  }, Effect.timeout("1 minute"));

  const download = Effect.fn("DesktopDevUpdates.download")(function* (
    directory: string,
    manifest: Protocol.DevUpdateManifest,
  ) {
    const archive = yield* httpClient.get(manifest.launchAsset.url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.map((buffer) => new Uint8Array(buffer)),
    );
    yield* protocolStep(() => Protocol.verifyAssetHash(archive, manifest.launchAsset.hash));
    const files = yield* gunzip(archive).pipe(
      Effect.flatMap((tar) => protocolStep(() => Protocol.readTar(tar))),
    );
    if (!files.some((file) => file.path === BUNDLE_ENTRY)) {
      return yield* new Protocol.DevUpdateProtocolError({
        reason: `the bundle has no ${BUNDLE_ENTRY} at its root`,
      });
    }
    const target = path.join(directory, manifest.id);
    const staging = `${target}.partial`;
    yield* fileSystem.remove(staging, { recursive: true, force: true });
    for (const file of files) {
      const filePath = path.join(staging, ...file.path.split("/"));
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFile(filePath, file.data);
    }
    yield* fileSystem.remove(target, { recursive: true, force: true });
    yield* fileSystem.rename(staging, target);
  }, Effect.timeout("10 minutes"));

  const check = Effect.fn("DesktopDevUpdates.check")(
    function* (reason: string) {
      const directory = yield* Ref.get(directoryRef);
      if (Option.isNone(directory) || !(yield* SynchronizedRef.get(stateRef)).enabled) return;
      const response = yield* fetchManifest(publicKey);
      const outcome = DevState.applyManifestResponse({
        state: yield* SynchronizedRef.get(stateRef),
        response,
        running: yield* Ref.get(runningRef),
        appVersion,
      });
      if (outcome._tag === "Keep") {
        yield* updateState((state) =>
          state.enabled ? { ...state, ready: outcome.state.ready } : state,
        );
      } else if (response._tag === "Update") {
        yield* download(directory.value, response.manifest);
        // Turning the switch off during the download drops the bundle.
        yield* updateState((state) =>
          state.enabled ? { ...state, ready: outcome.bundle } : state,
        );
        yield* logInfo("dev bundle ready for the next launch", {
          reason,
          updateId: outcome.bundle.updateId,
          commit: outcome.bundle.commit,
        });
      }
      yield* prune(directory.value);
    },
    (effect) => checkLock.withPermits(1)(effect),
    Effect.catchCause((cause) => logWarning("dev update check failed", { cause })),
  );

  const startCheck = (reason: string) => check(reason).pipe(Effect.forkIn(layerScope));

  const reloadWindows = Effect.sync(() => {
    for (const window of Electron.BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || !window.webContents.getURL().startsWith(appUrlPrefix)) continue;
      window.webContents.reloadIgnoringCache();
    }
  });

  /** Points the protocol at the bundle the state selects; windows pick it up on their next load. */
  const serveSelected = Effect.fn("DesktopDevUpdates.serveSelected")(function* () {
    const directory = yield* Ref.get(directoryRef);
    if (Option.isNone(directory)) return;
    const state = yield* SynchronizedRef.get(stateRef);
    const selected = DevState.selectLaunchBundle(state, appVersion);
    const bundleDirectory =
      selected === null ? null : path.join(directory.value, selected.updateId);
    const intact =
      bundleDirectory !== null &&
      (yield* fileSystem
        .exists(path.join(bundleDirectory, BUNDLE_ENTRY))
        .pipe(Effect.orElseSucceed(() => false)));
    const running = intact ? selected : null;
    yield* Ref.set(runningRef, running);
    // A bundle that cannot be served never becomes servable: drop it before pruning, unless a
    // check replaced it meanwhile.
    if (state.ready?.updateId !== running?.updateId) {
      yield* updateState((current) =>
        current.ready?.updateId === state.ready?.updateId
          ? { ...current, ready: running }
          : current,
      );
    }
    servedDirectory =
      running === null || bundleDirectory === null ? embeddedDirectory : bundleDirectory;
    yield* Ref.set(phaseRef, running === null ? "embedded" : "starting");
    yield* prune(directory.value);
    if (running !== null) {
      yield* logInfo("serving the dev bundle", {
        updateId: running.updateId,
        commit: running.commit,
      });
    }
  });

  const failBoot = Effect.fn("DesktopDevUpdates.failBoot")(function* (reason: string) {
    if (
      (yield* Ref.getAndUpdate(phaseRef, (phase) => (phase === "starting" ? "failed" : phase))) !==
      "starting"
    ) {
      return;
    }
    const running = yield* Ref.get(runningRef);
    if (running === null) return;
    yield* logWarning("dev bundle failed to start; reloading with the embedded bundle", {
      reason,
      updateId: running.updateId,
    });
    yield* updateState((state) => DevState.markBad(state, running.updateId)).pipe(
      Effect.catch((error) => logWarning("could not mark the dev bundle bad", { error })),
    );
    yield* serveSelected();
    yield* reloadWindows;
  });

  const isMainWindow = (window: Electron.BrowserWindow) =>
    electronWindow.main.pipe(Effect.map((main) => Option.contains(main, window)));

  const watchMainWindow = electronApp.on(
    "browser-window-created",
    (_event: Electron.Event, window: Electron.BrowserWindow) => {
      const failIfMain = (reason: string) =>
        runFork(
          isMainWindow(window).pipe(
            Effect.flatMap((isMain) => (isMain ? failBoot(reason) : Effect.void)),
          ),
        );
      window.webContents.on(
        "did-fail-load",
        (_loadEvent, errorCode, errorDescription, _url, isMainFrame) => {
          if (isMainFrame && errorCode !== ERR_ABORTED) failIfMain(errorDescription);
        },
      );
      window.webContents.on("render-process-gone", (_goneEvent, details) => {
        if (details.reason !== "clean-exit") failIfMain(`renderer ${details.reason}`);
      });
    },
  );

  const launch = Effect.fn("DesktopDevUpdates.launch")(
    function* (embeddedAssetDirectory: string) {
      const currentDirectory = () => servedDirectory;
      if (Option.isSome(yield* Ref.get(directoryRef))) return currentDirectory;
      embeddedDirectory = servedDirectory = embeddedAssetDirectory;
      const userDataPath = yield* appIdentity.resolveUserDataPath.pipe(Effect.option);
      if (Option.isNone(userDataPath)) return currentDirectory;
      const directory = path.join(userDataPath.value, BUNDLE_DIRECTORY);
      yield* Ref.set(directoryRef, Option.some(directory));
      const state = yield* readState(directory);
      yield* SynchronizedRef.set(stateRef, state);
      // A reload can start a dev bundle later, so windows are watched even when this launch has none.
      yield* watchMainWindow.pipe(Scope.provide(layerScope));
      yield* serveSelected();
      if (state.enabled) yield* startCheck("launch");
      return currentDirectory;
    },
    (effect, embeddedAssetDirectory) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          logWarning("could not choose a dev bundle", { cause }).pipe(
            Effect.as(() => embeddedAssetDirectory),
          ),
        ),
      ),
  );

  const setEnabled = Effect.fn("DesktopDevUpdates.setEnabled")(function* (enabled: boolean) {
    yield* updateState((state) => DevState.setEnabled(state, enabled)).pipe(Effect.orDie);
    const directory = yield* Ref.get(directoryRef);
    if (enabled) yield* startCheck("enabled");
    else if (Option.isSome(directory)) yield* prune(directory.value).pipe(Effect.ignore);
    return yield* bridgeState;
  });

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.DEV_UPDATES_GET_STATE_CHANNEL,
      payload: Schema.Void,
      result: DevUpdatesStateSchema,
      handler: () => bridgeState,
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.DEV_UPDATES_SET_ENABLED_CHANNEL,
      payload: Schema.Boolean,
      result: DevUpdatesStateSchema,
      handler: setEnabled,
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.DEV_UPDATES_RENDERER_BOOT_CHANNEL,
      payload: Schema.Literals(["started", "failed"]),
      result: Schema.Void,
      handler: Effect.fn("DesktopDevUpdates.rendererBoot")(function* (outcome) {
        if (outcome === "failed") return yield* failBoot("boot error");
        if (
          (yield* Ref.getAndUpdate(phaseRef, (phase) =>
            phase === "starting" ? "started" : phase,
          )) === "starting"
        ) {
          yield* logInfo("dev bundle started");
        }
      }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.DEV_UPDATES_RELOAD_CHANNEL,
      payload: Schema.Void,
      result: Schema.Void,
      handler: Effect.fn("DesktopDevUpdates.reload")(function* () {
        yield* serveSelected();
        yield* reloadWindows;
      }),
    }),
  );

  return DesktopDevUpdates.of({ launch, getState: bridgeState, setEnabled });
});

export const layer = Layer.effect(DesktopDevUpdates, make);
