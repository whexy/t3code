import { rexMacCliPath, type RexStatus } from "@t3tools/contracts/rex";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

/** A `rex` call that failed or answered something unreadable; `message` is Rex's own error. */
export class RexCliError extends Schema.TaggedError<RexCliError>()("RexCliError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface RexSessionRef {
  readonly sessionId: string;
  readonly label: string;
}

/** Everything the session lifecycle asks of the host's Rex server. */
export class RexCli extends Context.Service<
  RexCli,
  {
    readonly status: () => Effect.Effect<RexStatus>;
    readonly listSessions: () => Effect.Effect<ReadonlyArray<RexSessionRef>, RexCliError>;
    readonly create: (label: string, cwd: string) => Effect.Effect<string, RexCliError>;
    /** Whether a client that displays the session (it asked for a size) owns one of its blocks. */
    readonly takenOver: (sessionId: string) => Effect.Effect<boolean, RexCliError>;
    readonly kill: (sessionId: string) => Effect.Effect<void, RexCliError>;
  }
>()("t3/rex/RexCli") {}

const REX_TIMEOUT = "10 seconds";

const ServerStatusJson = Schema.fromJsonString(Schema.Struct({ host_id: Schema.String }));
const SessionListJson = Schema.fromJsonString(
  Schema.Struct({
    sessions: Schema.NullOr(
      Schema.Array(Schema.Struct({ session_id: Schema.String, label: Schema.String })),
    ),
  }),
);
const CreatedJson = Schema.fromJsonString(Schema.Struct({ session_id: Schema.String }));
const BlockListJson = Schema.fromJsonString(
  Schema.Struct({
    blocks: Schema.NullOr(
      Schema.Array(
        Schema.Struct({ block_id: Schema.String, creator_name: Schema.optional(Schema.String) }),
      ),
    ),
  }),
);
const BlockSizeJson = Schema.fromJsonString(
  Schema.Struct({
    owner: Schema.NullOr(Schema.String),
    desired: Schema.NullOr(Schema.Array(Schema.Struct({ client_id: Schema.String }))),
  }),
);

const TERMINAL_CREATOR = "com.superlogical.terminal";

/** Rex prints `Error: <reason>` first; the lines after it are diagnostics. */
const rexErrorMessage = (stderr: string, fallback: string): string => {
  const first = stderr.trim().split("\n")[0]?.trim() ?? "";
  const message = first.replace(/^Error:\s*/, "");
  return message.length > 0 ? message : fallback;
};

const make = Effect.fn("RexCli.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const macCli = rexMacCliPath(yield* HostProcess.HomeDirectory);
  const command =
    (yield* HostProcess.Platform) === "darwin" &&
    (yield* fileSystem.exists(macCli).pipe(Effect.orElseSucceed(() => false)))
      ? macCli
      : "rex";

  // --autostart=false: T3 must never start a Rex server of its own on the host.
  const run = (operation: string, args: ReadonlyArray<string>) =>
    runner
      .run({
        command,
        args: ["--autostart=false", ...args],
        timeout: REX_TIMEOUT,
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RexCliError({
              operation,
              message:
                cause._tag === "ProcessSpawnError"
                  ? "Rex isn't installed on this host"
                  : cause._tag === "ProcessTimeoutError"
                    ? "Rex didn't answer"
                    : cause.message,
            }),
        ),
        Effect.flatMap((output) =>
          output.code === 0
            ? Effect.succeed(output.stdout)
            : Effect.fail(
                new RexCliError({
                  operation,
                  message: rexErrorMessage(output.stderr, `rex exited with ${output.code}`),
                }),
              ),
        ),
      );

  const decode =
    <A>(operation: string, schema: Schema.Codec<A, string>) =>
    (stdout: string) =>
      Schema.decodeEffect(schema)(stdout).pipe(
        Effect.mapError(
          () => new RexCliError({ operation, message: "Rex answered something unexpected" }),
        ),
      );

  const status = () =>
    run("server status", ["server", "status", "--json"]).pipe(
      Effect.flatMap(decode("server status", ServerStatusJson)),
      Effect.map((server): RexStatus => ({ available: true, hostId: server.host_id })),
      Effect.catch((error) =>
        Effect.succeed<RexStatus>({ available: false, reason: error.message }),
      ),
    );

  const listSessions = () =>
    run("ls", ["ls", "--json"]).pipe(
      Effect.flatMap(decode("ls", SessionListJson)),
      Effect.map((list) =>
        (list.sessions ?? []).map((session) => ({
          sessionId: session.session_id,
          label: session.label,
        })),
      ),
    );

  const create = (label: string, cwd: string) =>
    run("new", ["new", label, "-c", cwd, "--json"]).pipe(
      Effect.flatMap(decode("new", CreatedJson)),
      Effect.map((created) => created.session_id),
    );

  const takenOver = Effect.fn("RexCli.takenOver")(function* (sessionId: string) {
    const blocks = yield* run("block ls", ["block", "ls", "-s", sessionId, "--json"]).pipe(
      Effect.flatMap(decode("block ls", BlockListJson)),
    );
    for (const block of blocks.blocks ?? []) {
      if (block.creator_name !== undefined && block.creator_name !== TERMINAL_CREATOR) continue;
      const size = yield* run("block size", [
        "block",
        "call",
        "-s",
        sessionId,
        "-b",
        block.block_id,
        "size",
      ]).pipe(Effect.flatMap(decode("block size", BlockSizeJson)));
      // The client that created the session owns its block without asking for a size.
      if (size.owner !== null && (size.desired ?? []).some((d) => d.client_id === size.owner)) {
        return true;
      }
    }
    return false;
  });

  const kill = (sessionId: string) => run("kill", ["kill", sessionId]).pipe(Effect.asVoid);

  return RexCli.of({ status, listSessions, create, takenOver, kill });
});

export const layer = Layer.effect(RexCli, make()).pipe(Layer.provide(ProcessRunner.layer));
