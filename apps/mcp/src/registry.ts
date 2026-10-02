import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const SERVER_ID = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * One paired T3 server. `id` is the server_id every tool result carries, so
 * renaming it orphans the session references a chat still holds.
 */
export const ServerRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The server's own identity; a re-pair must come from the same server. */
  environmentId: Schema.String,
  url: Schema.String,
  /** Bearer token with orchestration scopes only. Never leaves the bridge. */
  token: Schema.String,
  enabled: Schema.Boolean,
  pairedAt: Schema.String,
  expiresAt: Schema.String,
});
export type ServerRecord = typeof ServerRecord.Type;

export const BridgeState = Schema.Struct({
  /**
   * The MCP endpoint is `/mcp/<secret>`. ChatGPT connectors cannot send
   * custom headers, so the URL itself is the bridge's credential.
   */
  secret: Schema.String,
  /** Public origin MCP clients reach the bridge at, shown with the endpoint URL. */
  publicUrl: Schema.NullOr(Schema.String),
  servers: Schema.Array(ServerRecord),
});
export type BridgeState = typeof BridgeState.Type;

export type Pairing = Omit<ServerRecord, "id" | "enabled">;

const slugify = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "t3";

const find = (state: BridgeState, id: string) => state.servers.find((server) => server.id === id);

const checkId = (state: BridgeState, id: string, except?: string) => {
  if (!SERVER_ID.test(id)) {
    return Result.fail(
      `"${id}" is not a valid server id. Use lowercase letters, digits, "-" and "_".`,
    );
  }
  return state.servers.some((server) => server.id === id && server.id !== except)
    ? Result.fail(`Server id "${id}" is already in use.`)
    : Result.succeed(id);
};

const replace = (state: BridgeState, id: string, next: ServerRecord): BridgeState => ({
  ...state,
  servers: state.servers.map((server) => (server.id === id ? next : server)),
});

export function addServer(state: BridgeState, pairing: Pairing, requestedId?: string) {
  const existing = state.servers.find((server) => server.environmentId === pairing.environmentId);
  if (existing !== undefined) {
    return Result.fail(
      `This server is already paired as "${existing.id}". Re-pair that entry to refresh its token.`,
    );
  }
  return Result.map(checkId(state, requestedId ?? slugify(pairing.name)), (id): BridgeState => ({
    ...state,
    servers: [...state.servers, { ...pairing, id, enabled: true }],
  }));
}

/** Refreshes the token, and the URL the link came from, of a server paired before. */
export function repairServer(state: BridgeState, id: string, pairing: Pairing) {
  const server = find(state, id);
  if (server === undefined) return Result.fail(`No server "${id}".`);
  if (server.environmentId !== pairing.environmentId) {
    return Result.fail(`That link is for "${pairing.name}", a different server than "${id}".`);
  }
  return Result.succeed(
    replace(state, id, {
      ...server,
      url: pairing.url,
      token: pairing.token,
      pairedAt: pairing.pairedAt,
      expiresAt: pairing.expiresAt,
    }),
  );
}

export function updateServer(
  state: BridgeState,
  id: string,
  change: { readonly id?: string; readonly name?: string; readonly enabled?: boolean },
) {
  const server = find(state, id);
  if (server === undefined) return Result.fail(`No server "${id}".`);
  const name = change.name?.trim();
  if (name === "") return Result.fail("The name cannot be empty.");
  return Result.map(checkId(state, change.id ?? id, id), (nextId): BridgeState =>
    replace(state, id, {
      ...server,
      id: nextId,
      name: name ?? server.name,
      enabled: change.enabled ?? server.enabled,
    }),
  );
}

export function removeServer(state: BridgeState, id: string) {
  return find(state, id) === undefined
    ? Result.fail(`No server "${id}".`)
    : Result.succeed({ ...state, servers: state.servers.filter((server) => server.id !== id) });
}

export function setPublicUrl(state: BridgeState, input: string) {
  const trimmed = input.trim();
  if (trimmed === "") return Result.succeed({ ...state, publicUrl: null });
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return Result.fail(`"${trimmed}" is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Result.fail("The public URL must be an https:// URL.");
  }
  return Result.succeed({
    ...state,
    publicUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
  });
}

export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  message: Schema.String,
}) {}

const codec = Schema.fromJsonString(BridgeState);
const decodeState = Schema.decodeUnknownEffect(codec);
const encodeState = Schema.encodeEffect(codec);

export class Registry extends Context.Service<
  Registry,
  {
    readonly state: Effect.Effect<BridgeState>;
    /** Applies a validated change and persists it before any reader sees it. */
    readonly update: (
      change: (state: BridgeState) => Result.Result<BridgeState, string>,
    ) => Effect.Effect<BridgeState, RegistryError>;
    readonly rotateSecret: Effect.Effect<BridgeState, RegistryError>;
  }
>()("@t3tools/mcp/registry") {}

/** The bridge's state lives in `<dataDir>/state.json`, readable only by its owner. */
export const layer = (dataDir: string) =>
  Layer.effect(
    Registry,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const file = path.join(dataDir, "state.json");
      const newSecret = crypto
        .randomBytes(24)
        .pipe(
          Effect.map((bytes) =>
            Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          ),
        );
      const write = (state: BridgeState) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(`${file}.tmp`, yield* encodeState(state), {
            mode: 0o600,
          });
          yield* fileSystem.rename(`${file}.tmp`, file);
        });

      yield* fileSystem.makeDirectory(dataDir, { recursive: true });
      let initial: BridgeState;
      if (yield* fileSystem.exists(file)) {
        initial = yield* decodeState(yield* fileSystem.readFileString(file));
      } else {
        initial = { secret: yield* newSecret, publicUrl: null, servers: [] };
        yield* write(initial);
      }
      const current = yield* Ref.make(initial);
      const lock = yield* Semaphore.make(1);

      const commit = (next: BridgeState) =>
        write(next).pipe(
          Effect.andThen(Ref.set(current, next)),
          Effect.as(next),
          Effect.mapError(
            (cause) => new RegistryError({ message: `Could not save the bridge state: ${cause}` }),
          ),
        );

      return Registry.of({
        state: Ref.get(current),
        update: (change) =>
          Ref.get(current).pipe(
            Effect.flatMap((state) => {
              const next = change(state);
              return Result.isFailure(next)
                ? Effect.fail(new RegistryError({ message: next.failure }))
                : commit(next.success);
            }),
            Semaphore.withPermit(lock),
          ),
        rotateSecret: Effect.gen(function* () {
          const secret = yield* newSecret.pipe(
            Effect.mapError(() => new RegistryError({ message: "Could not generate a secret." })),
          );
          return yield* commit({ ...(yield* Ref.get(current)), secret });
        }).pipe(Semaphore.withPermit(lock)),
      });
    }),
  );
