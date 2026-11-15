# Wrapped by nix/desktop-dev.nix, which supplies the toolchain and strict mode.

# Every name the Dev app owns, kept apart from what an installed T3 Code uses.
app_name="T3 Code (Dev)"
bundle_id="com.t3tools.t3code.devapp"
# Names its T3 home, Electron profile, keychain key and link scheme.
token="devapp"
install_path="/Applications/$app_name.app"
t3_home="$HOME/.t3-$token"
profile_dir="$HOME/Library/Application Support/t3code-$token"

fail() {
  echo "t3-desktop-dev: $*" >&2
  exit 1
}

is_running() {
  [ "$(osascript -e "application id \"$bundle_id\" is running" 2>/dev/null)" = true ]
}

quit_app() {
  is_running || return 0
  echo "Quitting $app_name..."
  osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null || true
  # It asks before quitting while agents run, so give the user time to answer.
  for _ in $(seq 120); do
    is_running || return 0
    sleep 1
  done
  fail "$app_name is still running. Quit it and run this again."
}

if [ "${1:-}" = uninstall ]; then
  quit_app
  rm -rf "$install_path"
  echo "Removed $install_path. Its state stays in $t3_home, $profile_dir," \
    "and the keychain item \"t3code-$token Safe Storage\"."
  exit 0
fi
[ $# -eq 0 ] || fail "usage: t3-desktop-dev [uninstall]"

root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "run this inside a T3 Code checkout"
cache="$HOME/Library/Caches/t3-desktop-dev/$(printf '%s' "$root" | sha256sum | cut -c1-16)"
src="$cache/src"
mkdir -p "$src"

# A persistent copy keeps node_modules and build caches between runs. It takes
# the checkout's tracked and unignored files, uncommitted changes included;
# .repos is vendored reference code that no build reads.
git -C "$root" ls-files -z --cached --others --exclude-standard -- ':(exclude).repos' >"$cache/files.new"
if [ -f "$cache/files" ]; then
  comm -z -23 <(sort -z "$cache/files") <(sort -z "$cache/files.new") |
    (cd "$src" && xargs -0 rm -f --)
fi
git -C "$root" ls-files -z --deleted | (cd "$src" && xargs -0 rm -f --)
rsync -a --from0 --files-from="$cache/files.new" --ignore-missing-args "$root/" "$src/"
mv "$cache/files.new" "$cache/files"

# Each edit names an exact piece of source. A rebase that changes one fails
# here rather than building an app that shares the installed app's state.
patched=(
  apps/desktop/package.json
  apps/desktop/src/app/DesktopEnvironment.ts
  apps/desktop/src/app/DesktopStatePaths.ts
  apps/desktop/src/app/DesktopUserData.ts
  assets/prod/black-macos-1024.png
  scripts/build-desktop-artifact.ts
)
for file in "${patched[@]}"; do
  cp "$root/$file" "$src/$file"
done
replace() {
  # shellcheck disable=SC2016 # The ${...} are JavaScript's.
  node -e '
    const fs = require("node:fs");
    const [file, from, to] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    if (text.split(from).length !== 2) {
      console.error(`t3-desktop-dev: ${file} no longer has exactly one ${JSON.stringify(from)}; update nix/desktop-dev.sh.`);
      process.exit(1);
    }
    fs.writeFileSync(file, text.replace(from, () => to));
  ' "$src/$1" "$2" "$3"
}
replace apps/desktop/src/app/DesktopStatePaths.ts \
  'input.joinPath(input.homeDirectory, ".t3"),' \
  "input.joinPath(input.homeDirectory, \".t3-$token\"),"
replace apps/desktop/src/app/DesktopUserData.ts 'current: "t3code-v2"' "current: \"t3code-$token\""
replace apps/desktop/src/app/DesktopEnvironment.ts \
  'return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Beta";' \
  'return "Dev";'
replace apps/desktop/package.json '"productName": "T3 Code (Beta)"' "\"productName\": \"$app_name\""
replace scripts/build-desktop-artifact.ts \
  'const DESKTOP_APP_ID = "com.t3tools.t3code";' \
  "const DESKTOP_APP_ID = \"$bundle_id\";"
# Electron names the macOS keychain key "<name> Safe Storage" after this.
replace scripts/build-desktop-artifact.ts 'name: "t3code",' "name: \"t3code-$token\","
cp "$root/assets/dev/blueprint-macos-1024.png" "$src/assets/prod/black-macos-1024.png"

cd "$src"
pnpm install --frozen-lockfile --prefer-offline
export PATH="$src/node_modules/.bin:$PATH"

base="$(node -p 'require("./apps/server/package.json").version.split(/[-+]/)[0]')"
# Neither nightly nor preview, so no update feed; semver forbids leading zeros.
version="$base-$token.$(date -u +%Y%m%d).$((10#$(date -u +%H%M%S)))"
out="$cache/out"
rm -rf "$out"
# Without a repository the build writes no update feed. Nix's cc cannot link
# against the macOS SDK (no libiconv), so the resource monitor links with Xcode's.
env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY -u T3CODE_DESKTOP_SIGNED \
  T3CODE_TELEMETRY_CHANNEL=dev VITE_PLUS_TELEMETRY=0 \
  CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="${CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER:-/usr/bin/clang}" \
  node scripts/build-desktop-artifact.ts --platform mac --target dir \
  --build-version "$version" --output-dir "$out"
app="$(find "$out" -maxdepth 2 -name "$app_name.app" -print -quit)"
[ -n "$app" ] || fail "the build made no $app_name.app under $out"

# The installed app keeps t3code:// links and its place among web browsers.
/usr/libexec/PlistBuddy \
  -c "Delete :CFBundleURLTypes" \
  -c "Add :CFBundleURLTypes array" \
  -c "Add :CFBundleURLTypes:0 dict" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLName string T3 Code" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string t3code-$token" \
  -c "Delete :CFBundleDocumentTypes" \
  "$app/Contents/Info.plist"

# A stable identity keeps keychain and privacy grants across updates; an ad-hoc
# signature changes with every build.
identity="${T3_DESKTOP_DEV_SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  identities="$(security find-identity -v -p codesigning |
    sed -nE 's/^ *[0-9]+\) ([0-9A-F]{40}) "Apple Development:.*/\1/p')"
  identity="${identities%%$'\n'*}"
fi
if [ -z "$identity" ]; then
  echo "No Apple Development identity; signing ad hoc, so macOS asks for keychain access after each update." >&2
  identity=-
fi
codesign --force --deep --sign "$identity" "$app"

quit_app
rm -rf "$install_path"
ditto "$app" "$install_path"
rm -rf "$out"
# Marks the first launch done, so the app never puts its own t3 command on PATH.
mkdir -p "$t3_home/userdata"
touch "$t3_home/userdata/cli-command-first-launch"
open "$install_path"
echo "Installed $app_name $version from $root."
