# Builds the checkout you run it from as "T3 Code (Dev)" and installs it to
# /Applications, where it runs beside an installed T3 Code with its own state:
#
#   nix run -f nix/desktop-dev.nix                  # build and install
#   nix run -f nix/desktop-dev.nix '' uninstall     # '' selects the whole file
#
# From a checkout without this file, point at one that has it; the checkout
# built is always the one the command runs in.
#
# Not a sandboxed build: scripts/build-desktop-artifact.ts resolves the
# packaged app's dependencies and downloads Electron itself, so this supplies
# the pinned toolchain and runs that script on a patched copy of the checkout.
let
  lock = (builtins.fromJSON (builtins.readFile ../flake.lock)).nodes.nixpkgs.locked;
  nixpkgs = fetchTarball {
    url = "https://github.com/${lock.owner}/${lock.repo}/archive/${lock.rev}.tar.gz";
    sha256 = lock.narHash;
  };
  pkgs = import nixpkgs { };
  # Only its Node and pnpm pins are used; the server source is never read.
  server = pkgs.callPackage ./t3-server.nix { lastModifiedDate = "0"; };
in
pkgs.writeShellApplication {
  name = "t3-desktop-dev";
  runtimeInputs = [
    server.node
    server.pnpm
    pkgs.cargo
    pkgs.rustc
    pkgs.coreutils
    pkgs.findutils
    pkgs.rsync
    pkgs.git
  ];
  text = builtins.readFile ./desktop-dev.sh;
  meta.platforms = [ "aarch64-darwin" ];
}
