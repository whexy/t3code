/**
 * The server's credential check names each secret with `Buffer.from(value, "utf8")
 * .toString("base64url")`. That is the only use of `Buffer` in the code the editor runs, and
 * the names never reach the verdict, so this covers just that call.
 */
const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const BrowserBuffer = {
  from: (value: string) => ({
    toString: (encoding: string) => {
      if (encoding !== "base64url") throw new Error(`Unsupported Buffer encoding: ${encoding}`);
      return toBase64Url(new TextEncoder().encode(value));
    },
  }),
};

const scope = globalThis as { Buffer?: unknown };
scope.Buffer ??= BrowserBuffer;
