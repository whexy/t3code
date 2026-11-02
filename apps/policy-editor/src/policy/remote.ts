// @effect-diagnostics globalFetch:off globalDate:off - Plain browser requests, outside any Effect program.
/** The fleet policy `serve.ts` keeps at `/policy.json`, beside the editor. */
const POLICY_URL = "./policy.json";

export type RemoteLoad =
  | {
      readonly status: "saved";
      readonly text: string;
      readonly etag: string;
      readonly savedAt: Date;
    }
  | { readonly status: "empty" }
  /** No policy server answered, as under `vp dev`; the editor works on files only. */
  | { readonly status: "unavailable" };

export type RemoteSave =
  | { readonly status: "saved"; readonly etag: string; readonly savedAt: Date }
  | { readonly status: "conflict" }
  | { readonly status: "error"; readonly message: string };

// The server answers every request on this path, errors included, with JSON; anything else is
// a dev server's fallback page.
const isJson = (response: Response) =>
  response.headers.get("Content-Type")?.startsWith("application/json") === true;

const savedAtOf = (response: Response) => {
  const header = response.headers.get("Last-Modified");
  return header === null ? new Date() : new Date(header);
};

export async function loadRemotePolicy(): Promise<RemoteLoad> {
  let response: Response;
  try {
    response = await fetch(POLICY_URL, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    return { status: "unavailable" };
  }
  const etag = response.headers.get("ETag");
  if (response.status === 200 && isJson(response) && etag !== null) {
    return { status: "saved", text: await response.text(), etag, savedAt: savedAtOf(response) };
  }
  if (response.status === 404 && isJson(response)) return { status: "empty" };
  return { status: "unavailable" };
}

/** `etag` is the version the edit started from; null creates the first policy. */
export async function saveRemotePolicy(text: string, etag: string | null): Promise<RemoteSave> {
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
  const body = isJson(response) ? ((await response.json()) as { error?: unknown }) : {};
  return {
    status: "error",
    message: typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
  };
}

/** The first 12 hex digits of the policy's sha256, as hosts log it. */
export const sha12 = (etag: string) => etag.replace(/^W\//, "").replaceAll('"', "").slice(0, 12);
