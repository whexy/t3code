{
  lib,
  stdenv,
  fetchurl,
  fetchPnpmDeps,
  pnpmConfigHook,
  nodejs-slim,
  rustPlatform,
  autoPatchelfHook,
  jq,
  writableTmpDirAsHomeHook,
  versionCheckHook,
}:

let
  sources = lib.importJSON ./sources.json;
  root = ../.;
  fs = lib.fileset;
  rootPackage = lib.importJSON ../package.json;
  nodeVersion = rootPackage.engines.node;
  pnpmVersion = lib.removePrefix "pnpm@" rootPackage.packageManager;

  # The Node release upstream builds with. Its pristine binary becomes the
  # executable's runtime; a patched copy runs the build.
  nodeDist = fetchurl {
    url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz";
    hash = sources.nodeHash;
  };
  # autoPatchelf sets the interpreter before the rpath, which leaves Node's
  # release binary (and an executable built from it) crashing at startup;
  # setting the rpath first does not.
  patchNodeBinary = file: ''
    patchelf --set-rpath ${
      lib.makeLibraryPath [
        stdenv.cc.libc
        stdenv.cc.cc.lib
      ]
    } ${file}
    patchelf --set-interpreter "$(cat $NIX_CC/nix-support/dynamic-linker)" ${file}
  '';
  node = stdenv.mkDerivation {
    pname = "node-bin";
    version = nodeVersion;
    src = nodeDist;
    dontStrip = true;
    installPhase = ''
      cp -R . $out
      ${patchNodeBinary "$out/bin/node"}
    '';
  };

  pnpm = stdenv.mkDerivation {
    pname = "pnpm";
    version = pnpmVersion;
    src = fetchurl {
      url = "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-${pnpmVersion}.tgz";
      hash = sources.pnpmHash;
    };
    nativeBuildInputs = [ autoPatchelfHook ];
    buildInputs = [ stdenv.cc.cc.lib ];
    installPhase = "install -Dm755 pnpm $out/bin/pnpm";
    # fetchPnpmDeps runs its store fixup on this.
    passthru = { inherit nodejs-slim; };
  };

  # Every workspace project's manifest, so pnpm sees the workspace the lockfile
  # describes; only the projects the server build reads come in whole.
  manifests = fs.intersection (fs.fileFilter (file: file.name == "package.json") root) (
    fs.unions [
      (root + "/apps")
      (root + "/packages")
      (root + "/infra")
      (root + "/evals")
      (root + "/scripts")
      (root + "/oxlint-plugin-t3code")
    ]
  );

  src = fs.toSource {
    inherit root;
    fileset =
      fs.difference
        (fs.unions [
          manifests
          (root + "/package.json")
          (root + "/pnpm-lock.yaml")
          (root + "/pnpm-workspace.yaml")
          (root + "/.pnpmfile.cjs")
          (root + "/third-party-licenses.config.json")
          (root + "/third-party-licenses")
          # Notices that third-party-licenses.config.json points at, wherever they live.
          (fs.fileFilter (file: lib.hasPrefix "LICENSE" file.name) root)
          (root + "/tsconfig.base.json")
          (root + "/tsconfig.effect.json")
          (root + "/vite.config.ts")
          (root + "/patches")
          (root + "/assets")
          (root + "/infra/task-cache/src")
          (root + "/scripts/lib")
          (root + "/nix/prune-node-modules.ts")
          (root + "/apps/server")
          (root + "/apps/web")
          (root + "/packages")
        ])
        (
          fs.fileFilter (file: lib.hasSuffix ".test.ts" file.name || lib.hasSuffix ".test.tsx" file.name) root
        );
  };

  # Versioned by its own crate, so a nightly that leaves it alone reuses the cached build.
  resourceMonitor = rustPlatform.buildRustPackage {
    pname = "t3-resource-monitor";
    inherit ((lib.importTOML ../native/resource-monitor/Cargo.toml).package) version;
    src = fs.toSource {
      root = root + "/native/resource-monitor";
      fileset = root + "/native/resource-monitor";
    };
    cargoLock.lockFile = root + "/native/resource-monitor/Cargo.lock";
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "t3-server";
  inherit (sources) version;
  inherit src;

  pnpmWorkspaces = [
    "t3..."
    "@t3tools/monorepo"
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    inherit pnpm;
    fetcherVersion = 5;
    hash = sources.pnpmDepsHash;
    # The fetcher takes every platform's packages; this build needs Linux x64's,
    # including the musl builds some addons pick at runtime.
    prePnpmInstall = ''
      export pnpm_config_force_ignores_platform=false
      yq -i -y '.supportedArchitectures = {os: ["linux"], cpu: ["x64"], libc: ["glibc", "musl"]}' pnpm-workspace.yaml
    '';
  };

  nativeBuildInputs = [
    node
    pnpm
    pnpmConfigHook
    jq
    autoPatchelfHook
    writableTmpDirAsHomeHook
  ];

  # The libraries the Node runtime and the native addons link.
  buildInputs = [ stdenv.cc.cc.lib ];

  # Addons ship musl builds beside the glibc ones and load them only on musl.
  autoPatchelfIgnoreMissingDeps = [ "libc.musl-*.so.1" ];
  # The executable is patched in installPhase; only the addons go through here.
  dontAutoPatchelf = true;
  postFixup = ''
    autoPatchelf "$out/libexec/t3code/node_modules"
  '';

  # Stripping drops the payload a single executable carries.
  dontStrip = true;

  env = {
    # Matches upstream's nightly builds.
    T3CODE_TELEMETRY_CHANNEL = "nightly";
    VITE_PLUS_TELEMETRY = "0";
  };

  # What scripts/update-release-package-versions.ts does for a release, for the
  # manifests in this build; the version names the build channel too.
  postConfigure = ''
    for manifest in apps/server/package.json apps/web/package.json packages/contracts/package.json; do
      jq --arg version "$version" '.version = $version' "$manifest" > "$manifest.tmp"
      mv "$manifest.tmp" "$manifest"
    done
  '';

  # What release-desktop.yml runs for the CLI archive, minus scripts the
  # server build does not need. tsdown takes the executable's Node from its
  # download cache, seeded here with the pristine release binary.
  buildPhase = ''
    runHook preBuild

    # node-pty's install script picks its prebuilt binary for this platform.
    pnpm --filter=t3 rebuild node-pty
    node_modules/.bin/vp run --filter @t3tools/web build

    export XDG_CACHE_HOME="$TMPDIR/cache"
    nodeCache="$XDG_CACHE_HOME/tsdown/node/v${nodeVersion}/linux-x64"
    mkdir -p "$nodeCache"
    tar -xJf ${nodeDist} -O node-v${nodeVersion}-linux-x64/bin/node > "$nodeCache/node"
    chmod +x "$nodeCache/node"
    (cd apps/server && T3CODE_PACK_EXE=1 T3CODE_PACK_EXE_TARGET=linux-x64 ../../node_modules/.bin/vp pack)

    runHook postBuild
  '';

  # The layout of upstream's t3-<version>-linux-x64.tar.gz.
  installPhase = ''
    runHook preInstall

    dir="$out/libexec/t3code"
    install -Dm755 apps/server/dist-exe/t3-linux-x64 "$dir/t3"
    cp -R apps/web/dist "$dir/client"
    find "$dir/client" -name '*.map' -delete
    install -Dm755 ${resourceMonitor}/bin/t3-resource-monitor "$dir/resource-monitor/linux-x64/t3-resource-monitor"

    pnpm --filter=t3 --prod --offline --config.inject-workspace-packages=true deploy "$TMPDIR/deploy"
    node nix/prune-node-modules.ts "$TMPDIR/deploy"
    for prebuild in "$TMPDIR"/deploy/node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*; do
      [[ "''${prebuild##*/}" == linux-x64 ]] || rm -rf "$prebuild"
    done
    mv "$TMPDIR/deploy/node_modules" "$dir/node_modules"

    mkdir -p "$out/bin"
    ln -s ../libexec/t3code/t3 "$out/bin/t3"
    ${patchNodeBinary "$dir/t3"}

    runHook postInstall
  '';

  nativeInstallCheckInputs = [ versionCheckHook ];
  doInstallCheck = true;
  versionCheckProgramArg = "--version";

  passthru = { inherit node pnpm resourceMonitor; };

  meta = {
    description = "T3 Code server, built from the whexy/t3code self-hosted fork";
    homepage = "https://github.com/whexy/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3";
    platforms = [ "x86_64-linux" ];
  };
})
