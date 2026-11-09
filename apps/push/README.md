# t3-push

The fork's replacement for T3 Connect's push relay, for one owner. Every T3 server in the fleet
publishes its threads' agent activity here; t3-push merges all of them into the single Live
Activity card on the owner's iPhone, adds alerts, and sends both through APNs. iOS only.

Its delivery rules are a model-checked design: read
[verify-self-hosted-push](../../.agents/skills/verify-self-hosted-push/SKILL.md) before changing
how it stores, sends, or answers. The card and alert logic is the relay's own
(`infra/relay/src/agentActivity`), imported by path; `src/cardDelivery.ts` copies the part that
cannot be imported.

## Run it

After `vp i` at the repository root:

```sh
cd apps/push
vp test run   # deliveries against a fake APNs, the routes, and the HTTP/2 client
vp pack       # dist/bin.mjs, one file with no dependencies
DATA_DIR=./data HOST_TOKEN=… PHONE_TOKEN=… APNS_TEAM_ID=… APNS_KEY_ID=… \
  APNS_PRIVATE_KEY_FILE=./AuthKey.p8 node dist/bin.mjs
```

It refuses to start, naming the variable, when a required one is missing:

| Variable                                      | Required | Meaning                                                      |
| --------------------------------------------- | -------- | ------------------------------------------------------------ |
| `DATA_DIR`                                    | yes      | Directory for `push.sqlite` (`/data` in the image)           |
| `HOST_TOKEN`                                  | yes      | Bearer token every fleet host publishes with                 |
| `PHONE_TOKEN`                                 | yes      | Bearer token the owner's phones register with                |
| `APNS_TEAM_ID`, `APNS_KEY_ID`                 | yes      | The Apple team and the APNs auth key's id                    |
| `APNS_PRIVATE_KEY` or `APNS_PRIVATE_KEY_FILE` | one      | The `.p8` key's PEM text, or its path                        |
| `APNS_DEFAULT_BUNDLE_ID`                      | no       | APNs topic for a phone whose registration names no bundle id |
| `PORT`                                        | no       | Listener port, 8080 by default                               |

Each phone's registration picks APNs sandbox or production (`apsEnvironment`, production when
absent). SIGTERM closes the listener and the database.

## Endpoints

The relay's paths and JSON bodies (`packages/contracts/src/relay.ts`), so hosts and the app need
only a new URL and token. Each takes `Authorization: Bearer <token>`; no DPoP, and the publish
`proof` is ignored.

| Endpoint                                                                | Token |
| ----------------------------------------------------------------------- | ----- |
| `POST /v1/environments/:environmentId/threads/:threadId/agent-activity` | host  |
| `POST /v1/mobile/devices`                                               | phone |
| `POST /v1/mobile/live-activities`                                       | phone |
| `GET /v1/mobile/agent-activity`                                         | phone |
| `DELETE /v1/mobile/devices/:deviceId`                                   | phone |
| `GET /healthz`                                                          | none  |

A publish is answered only after a delivery that read it has been recorded for every registered
phone. A host whose request times out must publish again; t3-push does not redeliver after a
restart.

## Connect a host and the phone

- **Host:** set `T3CODE_PUSH_URL` (t3-push's public origin) and `T3CODE_PUSH_TOKEN` (`HOST_TOKEN`)
  in the T3 server's environment. They replace the T3 Connect link for agent activity.
- **Phone:** build the fork's iOS app with `T3CODE_PUSH_URL` and `T3CODE_PUSH_TOKEN`
  (`PHONE_TOKEN`) set; the app registers with t3-push instead of T3 Connect.

## Deployment

`.github/workflows/self-hosted-build.yml` publishes `ghcr.io/whexy/t3code-push` as `1.2.<run>`
with the other fork images. Run one replica with a `Recreate` rollout and a persistent volume at
`/data`, writable by uid 1000: deliveries are serialized inside the process, and a new pod must
not send while the old one still can.
