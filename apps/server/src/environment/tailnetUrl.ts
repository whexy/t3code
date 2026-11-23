import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const isOrigin = (url: URL) =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  url.pathname === "/" &&
  url.search === "" &&
  url.hash === "";

/**
 * The tailnet address of a host whose server cannot discover one, such as a host
 * that reaches the tailnet through a userspace node instead of tailscaled.
 */
export const TailnetUrlConfig = Config.URL("T3CODE_TAILNET_URL").pipe(
  Config.mapEffect((url) =>
    isOrigin(url)
      ? Effect.succeed(`${url.origin}/`)
      : Effect.fail(
          new Config.ConfigError(
            new Schema.SchemaError(
              new SchemaIssue.InvalidValue({
                message: "T3CODE_TAILNET_URL must be an https origin, such as https://host:8443.",
              }),
            ),
          ),
        ),
  ),
  Config.option,
  Config.map(Option.getOrUndefined),
);
