{
  description = "whexy/t3code: the T3 Code server, built from the self-hosted fork";

  # Consumers must not override nixpkgs (no `follows`): the output paths come
  # from this lock, and only those paths are in the CI cache.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forSystems (pkgs: rec {
        t3-server = pkgs.callPackage ./nix/t3-server.nix { inherit (self) lastModifiedDate; };
        default = t3-server;
      });
    };
}
