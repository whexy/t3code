# T3 Code policy editor

A web page for writing the [managed policy](../../docs/user/managed-policy.md) an administrator
deploys to machines running T3 Code. It shows each setting a policy can manage the way T3 Code's
Settings page does, and checks the policy as you edit with the server's own code, so what it
accepts `t3 policy check` accepts.

Policies stay in the browser: open or drop a file, paste JSON, or start a new one, then save back
to the same file (in Chromium browsers) or download it. The page needs no backend.

## Run it

After `vp i` at the repository root:

```sh
cd apps/policy-editor
vp dev        # http://localhost:5790
vp test run   # parity tests against `t3 policy check`
vp build      # the site, in dist/
```

The editor is not a workspace package, so the self-hosted branch carries upstream's lockfile
unchanged. Its `node_modules` is a committed link to the web app's, and it imports the few
packages only the server depends on by path.

## Deployment

`.github/workflows/self-hosted-build.yml` publishes `ghcr.io/whexy/t3code-policy-editor` on every
push to `self-hosted-nightly`, with the same `1.2.<run>` version as the web hub image, so each
nightly brings that nightly's policy rules. The image serves `dist/` with `serve.ts` on port
8080 and answers `GET /healthz`. `./build-image.sh` builds it locally.

## How it checks a policy

The editor runs `makeManagedSettings` and `makeManagedProviders` from `apps/server/src/policy`
and the `ManagedPolicyDocument` schema from `@t3tools/contracts`, as `t3 policy check` does.
Two server modules cannot run in a browser, so `vite.config.ts` swaps each for a shim that exports
the same values. The tests run every fixture through both the editor and `ManagedPolicy.load`.

The editor is stricter than `t3 policy check` in one way: it refuses settings that are not a
user's choice, such as state the server keeps for itself, and shows them so you can remove them.
That list is `HIDDEN_SETTINGS` in `src/policy/catalog.ts`. A setting the server cannot manage
never shows, since the editor offers only settings the server accepts.
