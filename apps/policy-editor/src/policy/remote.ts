// @effect-diagnostics globalFetch:off globalDate:off - Plain browser requests, outside any Effect program.
/** The named policies `serve.ts` keeps at `/api/policies`, beside the editor. */
const API_URL = "./api/policies";
const LOAD_TIMEOUT_MS = 10_000;

export const POLICY_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface PolicySummary {
  readonly name: string;
  readonly etag: string;
  readonly modifiedAt: Date;
  /** Where hosts fetch it, on the public listener. */
  readonly publicUrl: string;
}

export type RemoteList =
  | { readonly status: "listed"; readonly policies: ReadonlyArray<PolicySummary> }
  | { readonly status: "failed"; readonly message: string }
  /** No policy server at all, as under `vp dev`; the editor works on files only. */
  | { readonly status: "absent" };

export type RemoteLoad =
  | {
      readonly status: "saved";
      readonly text: string;
      readonly etag: string;
      readonly savedAt: Date;
    }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly message: string };

export type RemoteSave =
  | { readonly status: "saved"; readonly etag: string; readonly savedAt: Date }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

export type RemoteDelete =
  | { readonly status: "deleted" }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

// The policy server answers every API request, errors included, with JSON.
const isJson = (response: Response) =>
  response.headers.get("Content-Type")?.startsWith("application/json") === true;

const savedAtOf = (response: Response) => {
  const header = response.headers.get("Last-Modified");
  return header === null ? new Date() : new Date(header);
};

const policyUrl = (name: string) => `${API_URL}/${name}`;

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

function summaryOf(value: unknown): PolicySummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { name, etag, modifiedAt, publicUrl } = value as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    typeof etag !== "string" ||
    typeof modifiedAt !== "string" ||
    typeof publicUrl !== "string"
  ) {
    return undefined;
  }
  return { name, etag, modifiedAt: new Date(modifiedAt), publicUrl };
}

/** `dev` is true under `vp dev`, where a missing policy server means the editor works on files. */
export async function listPolicies(options: { readonly dev: boolean }): Promise<RemoteList> {
  try {
    const response = await fetch(API_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
    if (!isJson(response)) {
      return options.dev
        ? { status: "absent" }
        : { status: "failed", message: `unexpected response, HTTP ${response.status}` };
    }
    if (!response.ok) return { status: "failed", message: await errorOf(response) };
    const body = (await response.json()) as { policies?: unknown };
    const policies = Array.isArray(body.policies) ? body.policies.map(summaryOf) : [undefined];
    if (policies.includes(undefined)) {
      return { status: "failed", message: "the server sent a list the editor cannot read" };
    }
    return { status: "listed", policies: policies.filter((policy) => policy !== undefined) };
  } catch (error) {
    return options.dev ? { status: "absent" } : { status: "failed", message: messageOf(error) };
  }
}

export async function loadPolicy(name: string): Promise<RemoteLoad> {
  try {
    const response = await fetch(policyUrl(name), {
      cache: "no-store",
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
    const etag = response.headers.get("ETag");
    if (response.status === 200 && etag !== null) {
      return { status: "saved", text: await response.text(), etag, savedAt: savedAtOf(response) };
    }
    if (response.status === 404 && isJson(response)) return { status: "missing" };
    return { status: "failed", message: await errorOf(response) };
  } catch (error) {
    return { status: "failed", message: messageOf(error) };
  }
}

/** `etag` is the version the edit started from; null creates the policy. */
export async function savePolicy(
  name: string,
  text: string,
  etag: string | null,
): Promise<RemoteSave> {
  try {
    const response = await fetch(policyUrl(name), {
      method: "PUT",
      body: text,
      headers: {
        "Content-Type": "application/json",
        ...(etag === null ? { "If-None-Match": "*" } : { "If-Match": etag }),
      },
    });
    if (response.status === 412) return { status: "conflict", message: await errorOf(response) };
    const newEtag = response.headers.get("ETag");
    if (response.ok && newEtag !== null) {
      return { status: "saved", etag: newEtag, savedAt: savedAtOf(response) };
    }
    return { status: "error", message: await errorOf(response) };
  } catch (error) {
    return { status: "error", message: messageOf(error) };
  }
}

export async function deletePolicy(name: string, etag: string): Promise<RemoteDelete> {
  try {
    const response = await fetch(policyUrl(name), {
      method: "DELETE",
      headers: { "If-Match": etag },
    });
    if (response.status === 204) return { status: "deleted" };
    if (response.status === 412) return { status: "conflict", message: await errorOf(response) };
    return { status: "error", message: await errorOf(response) };
  } catch (error) {
    return { status: "error", message: messageOf(error) };
  }
}

/** The list, and the policy picked from it; `name` is undefined when nothing is stored. */
export interface Opened {
  readonly list: RemoteList;
  readonly name: string | undefined;
  readonly load: RemoteLoad | undefined;
}

/** Lists the policies and loads `requested`, or the first one when it is not stored. */
export async function openPolicies(requested: string | null | undefined): Promise<Opened> {
  const list = await listPolicies({ dev: import.meta.env.DEV });
  if (list.status !== "listed") return { list, name: undefined, load: undefined };
  const name = list.policies.some((policy) => policy.name === requested)
    ? (requested ?? undefined)
    : list.policies[0]?.name;
  return { list, name, load: name === undefined ? undefined : await loadPolicy(name) };
}

/** The first 12 hex digits of the policy's sha256, as hosts log it. */
export const sha12 = (etag: string) => etag.replace(/^W\//, "").replaceAll('"', "").slice(0, 12);
