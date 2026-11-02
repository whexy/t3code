# T3 Code policy editor

A static web page for writing the [managed policy](../../docs/user/managed-policy.md) an
administrator deploys to machines running T3 Code. It shows each setting a policy can manage the
way T3 Code's Settings page does, and checks the policy as you edit with the server's own code, so
what it accepts `t3 policy check` accepts.

It has no server. Policies stay in the browser: open or drop a file, paste JSON, or start a new
one, then save back to the same file (in Chromium browsers) or download it.

## Run it

```sh
vp run --filter @t3tools/policy-editor dev
```

`vp run --filter @t3tools/policy-editor build` writes the site to `apps/policy-editor/dist`, which
any static host can serve from any path.

## Deploy to Vercel

Import the repository as a new Vercel project and set its **Root Directory** to
`apps/policy-editor`. `vercel.json` there sets the install and build commands and the output
directory, so leave the other build settings at their defaults.

## How it checks a policy

The editor runs `makeManagedSettings` and `makeManagedProviders` from `apps/server/src/policy`
and the `ManagedPolicyDocument` schema from `@t3tools/contracts`, as `t3 policy check` does.
Two server modules cannot run in a browser, so `vite.config.ts` swaps each for a shim that exports
the same values. The tests run every fixture through both the editor and `ManagedPolicy.load`.

The editor is stricter than `t3 policy check` in one way: it refuses settings that are not a
user's choice, such as state the server keeps for itself, and shows them so you can remove them.
That list is `HIDDEN_SETTINGS` in `src/policy/catalog.ts`. A setting the server cannot manage
never shows, since the editor offers only settings the server accepts.
