# T3 Code policy editor

A web page for writing the [managed policy](../../docs/user/managed-policy.md) an administrator
deploys to machines running T3 Code, and the server that hosts it for the fleet. It shows each
setting a policy can manage the way T3 Code's Settings page does, and checks the policy as you
edit with the server's own code, so what it accepts `t3 policy check` accepts.

Served by `serve.ts`, the editor opens the fleet policy at `/policy.json` and Save writes it back
there; each T3 server fetches that URL and applies the policy the next time it starts. Open, Paste
and New replace what you are editing, and Save then publishes it; Download keeps a copy as a file.
If someone else saved since you loaded, Save is refused and Reload fetches their version. If the
policy cannot be loaded, the editor says why and Save stays off until Retry loads it.

Without that server, as under `vp dev`, policies stay in the browser: save back to the opened file
(in Chromium browsers) or download it.

## Run it

After `vp i` at the repository root:

```sh
cd apps/policy-editor
vp dev        # http://localhost:5790
vp test run   # parity tests against `t3 policy check`, and serve.ts over HTTP
vp build      # the site, in dist/
```

The editor is not a workspace package, so the self-hosted branch carries upstream's lockfile
unchanged. Its `node_modules` is a committed link to the web app's, and it imports the few
packages only the server depends on by path.

## Deployment

`.github/workflows/self-hosted-build.yml` publishes `ghcr.io/whexy/t3code-policy-editor` on every
push to `self-hosted-nightly`, with the same `1.2.<run>` version as the web hub image, so each
nightly brings that nightly's policy rules. `./build-image.sh` builds it locally. The image runs
`serve.ts` on port 8080:

- `GET /policy.json`: the saved policy with `ETag: "<sha256>"`; 404 before the first save.
- `PUT /policy.json`: replace it. `If-None-Match: *` creates the first one and `If-Match: "<etag>"`
  replaces that version (`*` for whichever is saved). A stale precondition gets 412 and a missing
  one 428. The body is a JSON object of at most 256 KiB with `schemaVersion: 1` and an
  `organization` string.
- `GET /healthz`: 200 while `POLICY_DIR` is a writable directory.

`POLICY_DIR` (`/data` in the image) holds `policy.json`. Mount a persistent volume there, writable
by uid 1000, and run one replica: saves are serialized inside the process. There is no login, so
serve it only where every client may change the fleet's policy.

```sh
curl -fsS -D- https://t3-policy.at-basking.ts.net/policy.json
curl -fsS -X PUT -H 'If-Match: "<etag>"' --data-binary @policy.json \
  https://t3-policy.at-basking.ts.net/policy.json
```

## How it checks a policy

The editor runs `makeManagedSettings` and `makeManagedProviders` from `apps/server/src/policy`
and the `ManagedPolicyDocument` schema from `@t3tools/contracts`, as `t3 policy check` does.
Two server modules cannot run in a browser, so `vite.config.ts` swaps each for a shim that exports
the same values. The tests run every fixture through both the editor and `ManagedPolicy.load`.

The editor is stricter than `t3 policy check` in one way: it refuses settings that are not a
user's choice, such as state the server keeps for itself, and shows them so you can remove them.
That list is `HIDDEN_SETTINGS` in `src/policy/catalog.ts`. A setting the server cannot manage
never shows, since the editor offers only settings the server accepts.
