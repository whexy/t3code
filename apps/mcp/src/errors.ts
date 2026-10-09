import * as Schema from "effect/Schema";

/** Tool failure. Its message reaches the model, so it never carries credentials. */
export class BridgeError extends Schema.TaggedError<BridgeError>()("BridgeError", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
}) {}
