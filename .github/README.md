# whexy/t3code

An unofficial fork of [T3 Code](https://github.com/pingdotgg/t3code) that
follows upstream's stable releases and runs Wenxuan's fleet: the machines
[whexy/dotfiles](https://github.com/whexy/dotfiles) manages, the clusters-work
Kubernetes cluster, an iPhone, and the desktop apps. It needs none of
upstream's hosted services. For T3 Code itself (install, docs, issues), go to
[pingdotgg/t3code](https://github.com/pingdotgg/t3code).

## What the fork adds

| Feature                                                       | What it does                                                                                                       | Where it runs                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Server ([`nix`](../nix))                                      | Upstream's `t3` server as a Nix package, with a managed policy file per user                                       | Every dotfiles host (x86_64-linux, aarch64-darwin)                                                              |
| Web hub ([`scripts/self-hosted`](../scripts/self-hosted))     | The web client, with connections kept in a shared catalog instead of one browser                                   | `https://t3.clusters.work`                                                                                      |
| Client MCP ([`apps/mcp`](../apps/mcp))                        | An MCP server that is a T3 Code client, so an MCP client can start and follow sessions on paired servers           | `https://t3-mcp.clusters.work/mcp`                                                                              |
| Policy editor ([`apps/policy-editor`](../apps/policy-editor)) | Edits named managed policies; hosts that follow one pick up a change within about 2 minutes                        | Edited on the tailnet at `t3-policy.at-basking.ts.net`, served at `https://t3-policy.clusters.work/<name>.json` |
| Push relay ([`apps/push`](../apps/push))                      | Sends the iOS app's notifications and Live Activity from every host's agent activity, replacing T3 Connect's relay | `https://t3-push.clusters.work`                                                                                 |
| iOS app                                                       | Upstream's app, signed for Wenxuan's Apple team and wired to the push relay                                        | TestFlight, as `dev.whexy.t3code`                                                                               |
| Desktop app                                                   | Upstream's nightly desktop app, updating from this repository's releases                                           | Linux, macOS, Windows                                                                                           |

## How a build reaches each device

![How a commit is checked, published, and delivered](assets/self-hosted-pipeline.svg)

When upstream publishes a stable release, the rebase puts `dev` on top of it
and moves `self-hosted-nightly` to `dev`, which starts the build. A build publishes only
while its commit is still the branch head; otherwise the newer push publishes
instead. From there:

| Destination         | Gets                                    | How                                                                                                               | When                                                           |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Cluster             | Hub, MCP, policy editor and push images | The build writes the `1.2.<run>` tag into clusters-work, and Argo CD rolls the apps                               | Minutes after the build                                        |
| Every dotfiles host | `t3-server`                             | dotfiles' pin lane pins the commit once Cachix has both builds; hosts switch to it and restart the server         | After dotfiles CI                                              |
| iPhone              | The app                                 | TestFlight `1.2.<run>`; JavaScript-only changes can also go [over the air](operations.md#over-the-air-updates)    | Every build                                                    |
| Desktops            | The app                                 | Mac and Windows apps update themselves from this repository's prereleases; Linux takes the AppImage dotfiles pins | Once per upstream nightly; later commits wait for the next one |

When the rebase or the build fails, nothing is published, so the last good
build keeps serving, and T3 Code starts an agent run that repairs `dev`.

## Shipping a change

Open pull requests against `dev`, the default branch. They run the checks
without the macOS leg and the desktop builds, publish nothing, and are
rebase-merged.

A merged pull request ships with the next upstream stable release. To ship it sooner,
merge the open "chore(release): promote dev to self-hosted-nightly" pull
request with a merge commit, or run
[`self-hosted-rebase.yml`](workflows/self-hosted-rebase.yml) by hand. Nobody
commits to `self-hosted-nightly` directly.

`dev` is the nightly tag upstream cut its latest stable release from, then the
fork's commits, then one `chore(nix): pin sources for <tag>` commit, then any pull requests merged since.
Every rebase replays it onto the new tag and force-pushes, so a `pin/<sha12>`
tag keeps each commit the build published fetchable.

## Using it outside the fleet

The server, from the public cache:

```sh
nix run \
  --option extra-substituters https://whexy-t3code.cachix.org \
  --option extra-trusted-public-keys 'whexy-t3code.cachix.org-1:/pDSZMaQ8YHPw/og8nsuwxiYCAAcRB8JYEcmNd2Czyg=' \
  'github:whexy/t3code/<commit>#t3-server' -- --version
```

Pin a commit, not a branch, since both are force-pushed. As a flake input, do
not make it follow your `nixpkgs`: the cache holds only the paths built from
the fork's own lock.

The hub, MCP and push images are public at `ghcr.io/whexy/t3code-<name>`;
take a `1.2.<run>` tag. The policy editor's image is private.

## Operating it

[operations.md](operations.md) covers over-the-air iOS updates, iOS and macOS
signing, certificate renewal dates, and why upstream's workflows are disabled.
