{
  lib,
  stdenv,
  fetchurl,
  fetchPnpmDeps,
  pnpmConfigHook,
  nodejs-slim,
  rustPlatform,
  autoPatchelfHook,
  darwin,
  jq,
  writableTmpDirAsHomeHook,
  versionCheckHook,
  # nix/update-sources.sh passes the pins it is computing.
  sources ? lib.importJSON ./sources.json,
}:

let
  # nix/update-sources.sh pins every system listed here.
  platforms = {
    x86_64-linux = {
      name = "linux-x64";
      # Including the musl builds some addons pick at runtime.
      pnpmArchitectures = ''{os: ["linux"], cpu: ["x64"], libc: ["glibc", "musl"]}'';
    };
    aarch64-darwin = {
      name = "darwin-arm64";
      pnpmArchitectures = ''{os: ["darwin"], cpu: ["arm64"]}'';
    };
  };
  inherit (stdenv.hostPlatform) system isLinux isDarwin;
  platform = platforms.${system} or (throw "t3-server: unsupported system ${system}");
  hashes = sources.${system};
  root = ../.;
  fs = lib.fileset;
  rootPackage = lib.importJSON ../package.json;
  nodeVersion = rootPackage.engines.node;
  pnpmVersion = lib.removePrefix "pnpm@" rootPackage.packageManager;

  # The Node release upstream builds with. Its pristine binary becomes the
  # executable's runtime; a patched copy runs the build.
  nodeDist = fetchurl {
    url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-${platform.name}.tar.xz";
    hash = hashes.nodeHash;
  };
  # autoPatchelf sets the interpreter before the rpath, which leaves Node's
  # release binary (and an executable built from it) crashing at startup;
  # setting the rpath first does not. macOS runs it as released.
  patchNodeBinary =
    file:
    lib.optionalString isLinux ''
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

  pnpm = stdenv.mkDerivation (
    {
      pname = "pnpm";
      version = pnpmVersion;
      src = fetchurl {
        url = "https://registry.npmjs.org/@pnpm/exe.${platform.name}/-/exe.${platform.name}-${pnpmVersion}.tgz";
        hash = hashes.pnpmHash;
      };
      installPhase = "install -Dm755 pnpm $out/bin/pnpm";
      # fetchPnpmDeps runs its store fixup on this.
      passthru = { inherit nodejs-slim; };
    }
    // lib.optionalAttrs isLinux {
      nativeBuildInputs = [ autoPatchelfHook ];
      buildInputs = [ stdenv.cc.cc.lib ];
    }
    # Stripping invalidates the release's signature.
    // lib.optionalAttrs isDarwin { dontStrip = true; }
  );

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

  # Where tsdown looks for its downloads; it ignores XDG on macOS.
  tsdownCache = if isDarwin then "$HOME/Library/Caches/tsdown" else "$XDG_CACHE_HOME/tsdown";

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

  pnpmDeps = finalAttrs.passthru.pnpmDepsFor.${system};

  nativeBuildInputs = [
    node
    pnpm
    pnpmConfigHook
    jq
  ]
  ++ lib.optional isLinux autoPatchelfHook
  ++ [ writableTmpDirAsHomeHook ]
  # tsdown signs the executable it builds with whichever codesign it finds.
  ++ lib.optional isDarwin darwin.sigtool;

  # The libraries the Node runtime and the native addons link.
  buildInputs = lib.optionals isLinux [ stdenv.cc.cc.lib ];

  # Addons ship musl builds beside the glibc ones and load them only on musl.
  autoPatchelfIgnoreMissingDeps = lib.optionals isLinux [ "libc.musl-*.so.1" ];
  # The executable is patched in installPhase; only the addons go through here.
  dontAutoPatchelf = true;
  postFixup = lib.optionalString isLinux ''
    autoPatchelf "$out/libexec/t3code/node_modules"
  '';

  # Stripping drops the payload a single executable carries.
  dontStrip = true;

  env = {
    # Matches upstream's nightly builds.
    T3CODE_TELEMETRY_CHANNEL = "nightly";
    VITE_PLUS_TELEMETRY = "0";
  };

  # Node's macOS release reads its OpenSSL config from here at startup.
  __impureHostDeps = lib.optionals isDarwin [ "/System/Library/OpenSSL" ];

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
    nodeCache="${tsdownCache}/node/v${nodeVersion}/${platform.name}"
    mkdir -p "$nodeCache"
    tar -xJf ${nodeDist} -O node-v${nodeVersion}-${platform.name}/bin/node > "$nodeCache/node"
    chmod +x "$nodeCache/node"
    (cd apps/server && T3CODE_PACK_EXE=1 T3CODE_PACK_EXE_TARGET=${platform.name} ../../node_modules/.bin/vp pack)

    runHook postBuild
  '';

  # The layout of upstream's t3-<version>-<platform>.tar.gz.
  installPhase = ''
    runHook preInstall

    dir="$out/libexec/t3code"
    install -Dm755 apps/server/dist-exe/t3-${platform.name} "$dir/t3"
    cp -R apps/web/dist "$dir/client"
    find "$dir/client" -name '*.map' -delete
    install -Dm755 ${resourceMonitor}/bin/t3-resource-monitor "$dir/resource-monitor/${platform.name}/t3-resource-monitor"

    pnpm --filter=t3 --prod --offline --config.inject-workspace-packages=true deploy "$TMPDIR/deploy"
    node nix/prune-node-modules.ts "$TMPDIR/deploy"
    for prebuild in "$TMPDIR"/deploy/node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*; do
      [[ "''${prebuild##*/}" == ${platform.name} ]] || rm -rf "$prebuild"
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

  passthru = {
    inherit
      node
      pnpm
      resourceMonitor
      platforms
      ;
    # Every system's: what pnpm fetches depends only on the platforms it is
    # told to take, so nix/update-sources.sh pins them all from one machine.
    pnpmDepsFor = lib.mapAttrs (
      depsSystem: depsPlatform:
      fetchPnpmDeps {
        inherit (finalAttrs)
          pname
          version
          src
          pnpmWorkspaces
          ;
        inherit pnpm;
        fetcherVersion = 5;
        hash = sources.${depsSystem}.pnpmDepsHash;
        # The fetcher takes every platform's packages; a build needs its own.
        prePnpmInstall = ''
          export pnpm_config_force_ignores_platform=false
          yq -i -y '.supportedArchitectures = ${depsPlatform.pnpmArchitectures}' pnpm-workspace.yaml
        '';
      }
    ) platforms;
  };

  meta = {
    description = "T3 Code server, built from the whexy/t3code self-hosted fork";
    homepage = "https://github.com/whexy/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3";
    platforms = builtins.attrNames platforms;
  };
})
