import { rexMacCliPath } from "@t3tools/contracts/rex";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as Channels from "./channels.ts";
import { classifySelect, selectInApp, type SelectAttempt } from "./select.ts";

const REX_BUNDLE_ID = "com.superlogical.rex";

const SelectInput = Schema.Struct({ sessionId: Schema.String, clickedAt: Schema.Number });
const SelectOutcome = Schema.Literals(["selected", "failed", "timedOut", "notListed", "expired"]);

const make = Effect.gen(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const isMac = (yield* HostProcess.Platform) === "darwin";
  const cli = rexMacCliPath(yield* HostProcess.HomeDirectory);

  const run = (command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, { stdin: "ignore", env: environment }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, code: Number(code) };
      }),
    );

  const available = isMac
    ? fileSystem.exists(cli).pipe(Effect.orElseSucceed(() => false))
    : Effect.succeed(false);

  const select = Effect.fn("DesktopRex.select")(
    function* (input: typeof SelectInput.Type) {
      // The Mac's own app is the one whose label is the computer name.
      const label = (yield* run("/usr/sbin/scutil", ["--get", "ComputerName"])).stdout.trim();
      return yield* selectInApp(input.clickedAt, {
        select: (timeoutMs) =>
          run(cli, [
            "--autostart=false",
            "-C",
            label,
            "do",
            "session.select",
            `session_id=${input.sessionId}`,
            "--json",
          ]).pipe(
            Effect.map(({ code, stderr }) => classifySelect(code, stderr)),
            // Closing the scope on timeout ends the process; the app may still act on its request.
            Effect.timeoutOption(timeoutMs),
            Effect.map((attempt): SelectAttempt =>
              attempt._tag === "Some" ? attempt.value : "timeout",
            ),
          ),
        openApp: run("/usr/bin/open", ["-b", REX_BUNDLE_ID]).pipe(Effect.asVoid),
      });
    },
    Effect.orElseSucceed(() => "failed" as const),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.REX_AVAILABLE_CHANNEL,
      payload: Schema.Undefined,
      result: Schema.Boolean,
      handler: () => available,
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.REX_SELECT_CHANNEL,
      payload: SelectInput,
      result: SelectOutcome,
      handler: (input) => (isMac ? select(input) : Effect.succeed("failed" as const)),
    }),
  );
});

export const layer = Layer.effectDiscard(make);
