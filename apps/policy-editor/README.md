# T3 Code policy editor

A web page for writing the [managed policies](../../docs/user/managed-policy.md) an administrator
deploys to machines running T3 Code, and the server that hosts them for the fleet. It shows each
setting a policy can manage the way T3 Code's Settings page does, and checks the policy as you
edit with the server's own code, so what it accepts `t3 policy check` accepts.

Served by `serve.ts`, the editor keeps any number of named policies. Pick one in the sidebar to
edit it; Save publishes it, and hosts following it pick it up within about 2 minutes, restarting
their T3 server to apply it. Hosts following a deleted policy keep their last good copy and alert.
The sidebar also starts a new policy, forks the open one under a new name, imports a file or pasted
JSON into it, reloads it, and deletes it, and shows the public URL hosts fetch it from. If someone
else saved since you loaded, Save is refused and keeps your edits; Reload fetches their version.

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
nightly brings that nightly's policy rules. `./build-image.sh` builds it locally.

The image runs `serve.ts` with two listeners over one directory of policies:

| Port                 | Serves                                                     | Expose it to                           |
| -------------------- | ---------------------------------------------------------- | -------------------------------------- |
| `PORT` (8080)        | The editor and the write API                               | Administrators only: there is no login |
| `PUBLIC_PORT` (8081) | `GET`/`HEAD /<name>.json` and `GET /healthz`, nothing else | Hosts, including the public internet   |

Each policy is `POLICY_DIR/<name>.json` (`/data` in the image), where a name is 1 to 63 lowercase
letters, digits and hyphens, starting with a letter or digit; `policy` is reserved. Mount a
persistent volume there, writable by uid 1000, and run one replica: changes are serialized inside
the process. `PUBLIC_URL` (default `https://t3-policy.clusters.work`) is the public listener's
origin, which the editor shows as each policy's URL. `WEB_ROOT` (`/app/dist` in the image) holds
the built editor.

The first time `serve.ts` opens a directory from the single-policy server, it renames
`policy.json` to `dotfiles.json` and logs it. Any `policy.json` it finds later, or alongside an
existing `dotfiles.json`, is moved to `.legacy/` with a timestamp, logged, and never served.

### Public listener

Hosts fetch `https://t3-policy.clusters.work/<name>.json`. A response carries
`ETag: "<sha256 of the file's bytes>"` and `Cache-Control: no-cache`, and answers 304 to a matching
`If-None-Match`. Any other method gets 405, and any other path 404, including names that are not
stored. It cannot list policies.

```sh
curl -fsS -D- https://t3-policy.clusters.work/dotfiles.json
```

### Write API

On the admin listener, every response is JSON and every ETag is `"<sha256>"`:

- `GET /api/policies`: `{ "policies": [{ name, etag, size, modifiedAt, publicUrl }] }`, by name.
- `GET /api/policies/<name>`: the policy, with `ETag` and `Last-Modified`; 404 if there is none.
- `PUT /api/policies/<name>`: `If-None-Match: *` creates it, and `If-Match: "<etag>"` replaces that
  version (`*` for whichever is saved). The body is a JSON object of at most 256 KiB with
  `schemaVersion: 1` and an `organization` string.
- `DELETE /api/policies/<name>`: needs `If-Match`; answers 204.
- `GET /healthz`: 200 while `POLICY_DIR` is a writable directory.

A stale precondition gets 412, a missing one 428, and a name outside the pattern 400. Writes land
by atomic rename, so hosts never read a partial file.

```sh
curl -fsS -X PUT -H 'If-Match: "<etag>"' --data-binary @dotfiles.json \
  https://t3-policy.at-basking.ts.net/api/policies/dotfiles
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
