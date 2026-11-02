{
  lib,
  stdenv,
  nodejs_26,
  pnpm_12,
  fetchPnpmDeps,
  pnpmConfigHook,
  rustPlatform,
  makeWrapper,
  jq,
  python3,
  pkg-config,
  versionCheckHook,
}:

let
  sources = lib.importJSON ./sources.json;
  root = ../.;
  fs = lib.fileset;

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
          (root + "/vite.config.ts")
          (root + "/patches")
          (root + "/assets")
          (root + "/infra/task-cache/src")
          (root + "/scripts/lib")
          (root + "/scripts/apply-web-brand-assets.ts")
          (root + "/nix/prune-node-modules.ts")
          (root + "/apps/server")
          (root + "/apps/web")
          (root + "/packages")
        ])
        (
          fs.fileFilter (file: lib.hasSuffix ".test.ts" file.name || lib.hasSuffix ".test.tsx" file.name) root
        );
  };

  resourceMonitor = rustPlatform.buildRustPackage {
    pname = "t3-resource-monitor";
    inherit (sources) version;
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
    pnpm = pnpm_12;
    fetcherVersion = 5;
    hash = sources.pnpmDepsHash;
  };

  nativeBuildInputs = [
    nodejs_26
    pnpm_12
    pnpmConfigHook
    makeWrapper
    jq
    python3
    pkg-config
  ];

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

  buildPhase = ''
    runHook preBuild
    # node-pty's install script picks its prebuilt binary for this platform.
    pnpm --filter=t3 rebuild node-pty
    # apps/server/scripts/cli.ts build, without the development icons and the
    # scripts package it imports.
    node_modules/.bin/vp run --filter @t3tools/web build
    (cd apps/server && ../../node_modules/.bin/vp pack)
    cp -R apps/web/dist apps/server/dist/client
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    pnpm --filter=t3 --prod --offline --config.inject-workspace-packages=true deploy "$out/lib/t3"
    node nix/prune-node-modules.ts "$out/lib/t3"
    rm -rf "$out/lib/t3/dist" "$out/lib/t3"/{pnpm-lock.yaml,pnpm-workspace.yaml,README.md}
    cp -R apps/server/dist "$out/lib/t3/dist"
    find "$out/lib/t3/dist" -name '*.map' -delete
    install -Dm755 ${resourceMonitor}/bin/t3-resource-monitor "$out/lib/t3/dist/resource-monitor/t3-resource-monitor"
    makeWrapper ${lib.getExe nodejs_26} "$out/bin/t3" --add-flags "$out/lib/t3/dist/bin.mjs"
    runHook postInstall
  '';

  nativeInstallCheckInputs = [ versionCheckHook ];
  doInstallCheck = true;
  versionCheckProgramArg = "--version";

  passthru = { inherit resourceMonitor; };

  meta = {
    description = "T3 Code server, built from the whexy/t3code self-hosted fork";
    homepage = "https://github.com/whexy/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
})
