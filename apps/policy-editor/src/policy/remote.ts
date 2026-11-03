// @effect-diagnostics globalFetch:off globalDate:off - Plain browser requests, outside any Effect program.
/** The fleet policy `serve.ts` keeps at `/policy.json`, beside the editor. */
const POLICY_URL = "./policy.json";
const LOAD_TIMEOUT_MS = 10_000;

export type RemoteLoad =
  | {
      readonly status: "saved";
      readonly text: string;
      readonly etag: string;
      readonly savedAt: Date;
    }
  | { readonly status: "empty" }
  | { readonly status: "failed"; readonly message: string }
  /** No policy server at all, as under `vp dev`; the editor works on files only. */
  | { readonly status: "absent" };

export type RemoteSave =
  | { readonly status: "saved"; readonly etag: string; readonly savedAt: Date }
  | { readonly status: "conflict" }
  | { readonly status: "error"; readonly message: string };

// The policy server answers every request on this path, errors included, with JSON.
const isJson = (response: Response) =>
  response.headers.get("Content-Type")?.startsWith("application/json") === true;

const savedAtOf = (response: Response) => {
  const header = response.headers.get("Last-Modified");
  return header === null ? new Date() : new Date(header);
};

function messageOf(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `the server did not answer within ${LOAD_TIMEOUT_MS / 1000} s`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function errorOf(response: Response): Promise<string> {
  if (isJson(response)) {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  }
  return `HTTP ${response.status}`;
}

/** `dev` is true under `vp dev`, where a missing policy server means the editor works on files. */
export async function loadRemotePolicy(options: { readonly dev: boolean }): Promise<RemoteLoad> {
  try {
    const response = await fetch(POLICY_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
    if (!isJson(response)) {
      return options.dev
        ? { status: "absent" }
        : { status: "failed", message: `unexpected response, HTTP ${response.status}` };
    }
    const etag = response.headers.get("ETag");
    if (response.status === 200 && etag !== null) {
      return { status: "saved", text: await response.text(), etag, savedAt: savedAtOf(response) };
    }
    if (response.status === 404) return { status: "empty" };
    return { status: "failed", message: await errorOf(response) };
  } catch (error) {
    return options.dev ? { status: "absent" } : { status: "failed", message: messageOf(error) };
  }
}

/** `etag` is the version the edit started from; null creates the first policy. */
export async function saveRemotePolicy(text: string, etag: string | null): Promise<RemoteSave> {
  try {
    const response = await fetch(POLICY_URL, {
      method: "PUT",
      body: text,
      headers: {
        "Content-Type": "application/json",
        ...(etag === null ? { "If-None-Match": "*" } : { "If-Match": etag }),
      },
    });
    if (response.status === 412) return { status: "conflict" };
    const newEtag = response.headers.get("ETag");
    if (response.ok && newEtag !== null) {
      return { status: "saved", etag: newEtag, savedAt: savedAtOf(response) };
    }
    return { status: "error", message: await errorOf(response) };
  } catch (error) {
    return { status: "error", message: messageOf(error) };
  }
}

/** The first 12 hex digits of the policy's sha256, as hosts log it. */
export const sha12 = (etag: string) => etag.replace(/^W\//, "").replaceAll('"', "").slice(0, 12);
