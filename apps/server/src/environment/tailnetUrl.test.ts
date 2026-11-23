import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { TailnetUrlConfig } from "./tailnetUrl.ts";

const parse = (env: Record<string, string>) =>
  TailnetUrlConfig.parse(ConfigProvider.fromEnv({ env })).pipe(Effect.result);

it.effect("reads T3CODE_TAILNET_URL as an https origin", () =>
  Effect.gen(function* () {
    expect(yield* parse({})).toEqual(Result.succeed(undefined));
    for (const [value, origin] of [
      ["https://mars-relay.tail1234.ts.net:35338", "https://mars-relay.tail1234.ts.net:35338/"],
      ["https://Mars-Relay.tail1234.ts.net:443/", "https://mars-relay.tail1234.ts.net/"],
    ] as const) {
      expect(yield* parse({ T3CODE_TAILNET_URL: value })).toEqual(Result.succeed(origin));
    }
    for (const value of [
      "http://mars-relay.tail1234.ts.net:35338",
      "https://mars-relay.tail1234.ts.net/t3",
      "https://mars-relay.tail1234.ts.net/?x=1",
      "https://user:pass@mars-relay.tail1234.ts.net",
      "mars-relay.tail1234.ts.net",
    ]) {
      expect(Result.isFailure(yield* parse({ T3CODE_TAILNET_URL: value }))).toBe(true);
    }
  }),
);
