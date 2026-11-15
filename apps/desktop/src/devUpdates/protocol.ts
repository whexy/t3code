// @effect-diagnostics nodeBuiltinImport:off -- RSA verification and SHA-256 over exact response bytes.
import * as NodeCrypto from "node:crypto";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The expo-updates protocol v1 subset ota.clusters.work speaks to the desktop app.

export const SIGNATURE_ALGORITHM = "rsa-v1_5-sha256";
export const SIGNATURE_KEY_ID = "main";

export class DevUpdateProtocolError extends Schema.TaggedError<DevUpdateProtocolError>()(
  "DevUpdateProtocolError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Dev update rejected: ${this.reason}`;
  }
}

const fail = (reason: string): never => {
  throw new DevUpdateProtocolError({ reason });
};

export interface MultipartPart {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Uint8Array;
}

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

export function parseMultipartMixed(
  contentType: string,
  body: Uint8Array,
): ReadonlyArray<MultipartPart> {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundaryValue = boundary?.[1] ?? boundary?.[2];
  if (!/^multipart\/mixed\b/i.test(contentType.trim()) || boundaryValue === undefined) {
    return fail("the manifest response is not multipart/mixed");
  }
  const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const delimiter = Buffer.from(`--${boundaryValue}`);
  const parts: MultipartPart[] = [];
  let position = buffer.indexOf(delimiter);
  if (position === -1) return fail("the multipart body has no boundary");
  for (;;) {
    position += delimiter.length;
    if (buffer.subarray(position, position + 2).toString("latin1") === "--") return parts;
    const lineEnd = buffer.indexOf(CRLF, position);
    if (lineEnd === -1) return fail("the multipart body ends inside a boundary line");
    const partStart = lineEnd + CRLF.length;
    const next = buffer.indexOf(Buffer.concat([CRLF, delimiter]), partStart);
    if (next === -1) return fail("the multipart body has no closing boundary");
    const part = buffer.subarray(partStart, next);
    const headerEnd = part.indexOf(HEADER_END);
    const headerBlock = headerEnd === -1 ? part : part.subarray(0, headerEnd);
    const headers = new Map<string, string>();
    for (const line of headerBlock.toString("latin1").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0)
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    parts.push({
      headers,
      body: headerEnd === -1 ? new Uint8Array() : part.subarray(headerEnd + HEADER_END.length),
    });
    position = next + CRLF.length;
  }
}

export function multipartPartName(part: MultipartPart): string | null {
  const disposition = part.headers.get("content-disposition") ?? "";
  return (
    /\bname="([^"]*)"/.exec(disposition)?.[1] ?? /\bname=([^;\s]+)/.exec(disposition)?.[1] ?? null
  );
}

// The structured-field dictionary of an expo-signature header, strings only.
function parseSignatureHeader(header: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const match of header.matchAll(/([a-z][a-z0-9_.*-]*)=("(?:[^"\\]|\\.)*"|[^,\s]*)/g)) {
    const [, key, raw] = match;
    if (key === undefined || raw === undefined) continue;
    entries.set(key, raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw);
  }
  return entries;
}

export type PublicKey = NodeCrypto.KeyObject;

export function publicKeyFromCertificate(pem: string): PublicKey {
  return new NodeCrypto.X509Certificate(pem).publicKey;
}

function verifySignature(input: {
  readonly body: Uint8Array;
  readonly header: string | undefined;
  readonly publicKey: PublicKey;
}): void {
  if (input.header === undefined) return fail("the response is unsigned");
  const signature = parseSignatureHeader(input.header);
  const alg = signature.get("alg") ?? SIGNATURE_ALGORITHM;
  const keyId = signature.get("keyid") ?? SIGNATURE_KEY_ID;
  const sig = signature.get("sig");
  if (alg !== SIGNATURE_ALGORITHM) return fail(`unsupported signature algorithm ${alg}`);
  if (keyId !== SIGNATURE_KEY_ID) return fail(`unknown signing key ${keyId}`);
  if (sig === undefined) return fail("the signature header has no sig");
  const valid = NodeCrypto.verify(
    "sha256",
    input.body,
    input.publicKey,
    Buffer.from(sig, "base64"),
  );
  if (!valid) fail("the signature does not match the response");
}

export function verifyAssetHash(data: Uint8Array, expectedHash: string): void {
  const actual = NodeCrypto.createHash("sha256").update(data).digest("base64url");
  if (actual !== expectedHash.replace(/=+$/, "")) fail("the bundle's hash does not match");
}

const ManifestAsset = Schema.Struct({
  hash: Schema.String,
  key: Schema.String,
  contentType: Schema.String,
  fileExtension: Schema.optionalKey(Schema.String),
  url: Schema.String,
});

const Manifest = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  runtimeVersion: Schema.String,
  launchAsset: ManifestAsset,
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type DevUpdateManifest = typeof Manifest.Type;

const Directive = Schema.Struct({ type: Schema.String });

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));
const decodeDirective = Schema.decodeUnknownOption(Schema.fromJsonString(Directive));

// Update ids name directories, so only UUID-shaped ids are accepted.
const UPDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export type ManifestResponse =
  | { readonly _tag: "Update"; readonly manifest: DevUpdateManifest }
  | { readonly _tag: "NoUpdate" }
  | { readonly _tag: "RollBackToEmbedded" };

/** Reads a signed manifest or directive response; anything unsigned or malformed throws. */
export function readManifestResponse(input: {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: Uint8Array;
  readonly publicKey: PublicKey;
}): ManifestResponse {
  if (input.status === 204) return { _tag: "NoUpdate" };
  if (input.status !== 200) return fail(`the manifest request returned ${input.status}`);
  const parts = parseMultipartMixed(input.contentType ?? "", input.body);
  const part = parts.find((candidate) => {
    const name = multipartPartName(candidate);
    return name === "manifest" || name === "directive";
  });
  if (part === undefined) return fail("the response has neither a manifest nor a directive");
  verifySignature({
    body: part.body,
    header: part.headers.get("expo-signature"),
    publicKey: input.publicKey,
  });
  const text = Buffer.from(part.body).toString("utf8");
  if (multipartPartName(part) === "directive") {
    const directive = Option.getOrNull(decodeDirective(text));
    if (directive?.type === "noUpdateAvailable") return { _tag: "NoUpdate" };
    if (directive?.type === "rollBackToEmbedded") return { _tag: "RollBackToEmbedded" };
    return fail(`unknown directive ${directive?.type ?? "(malformed)"}`);
  }
  const manifest = Option.getOrNull(decodeManifest(text));
  if (manifest === null) return fail("the manifest is malformed");
  if (!UPDATE_ID_PATTERN.test(manifest.id)) return fail(`invalid update id ${manifest.id}`);
  if (!manifest.launchAsset.url.startsWith("https://")) {
    return fail("the bundle URL is not https");
  }
  return { _tag: "Update", manifest };
}

export interface TarFile {
  readonly path: string;
  readonly data: Uint8Array;
}

const BLOCK = 512;

const readString = (block: Buffer, start: number, length: number) => {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
};

function readOctal(block: Buffer, start: number, length: number): number {
  if ((block[start] ?? 0) & 0x80) return fail("the bundle has an entry too large to read");
  const text = readString(block, start, length).trim();
  const value = text === "" ? 0 : Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) return fail("the bundle has a corrupt tar header");
  return value;
}

function paxPath(data: Buffer): string | undefined {
  let path: string | undefined;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("latin1"), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

/** Relative path inside the bundle root, or null for the root itself. */
function normalizeEntryPath(raw: string): string | null {
  if (raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) {
    return fail(`the bundle has an unsafe path ${raw}`);
  }
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  // A colon would name a drive or an alternate data stream on Windows.
  if (parts.some((part) => part === ".." || part.includes(":"))) {
    return fail(`the bundle has an unsafe path ${raw}`);
  }
  return parts.length === 0 ? null : parts.join("/");
}

/** The regular files in an uncompressed tar; links and devices are refused. */
export function readTar(archive: Uint8Array): ReadonlyArray<TarFile> {
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const files: TarFile[] = [];
  let longPath: string | undefined;
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return files;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + BLOCK;
    const data = buffer.subarray(dataStart, dataStart + size);
    if (data.length !== size) return fail("the bundle archive is truncated");
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      longPath = paxPath(data);
      continue;
    }
    if (type === "L") {
      longPath = readString(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;
    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    const rawPath = longPath ?? (prefix === "" ? name : `${prefix}/${name}`);
    longPath = undefined;
    const path = normalizeEntryPath(rawPath);
    if (type === "5") continue;
    if (type !== "0" && type !== "\0" && type !== "7") {
      return fail(`the bundle has an unsupported entry ${rawPath}`);
    }
    if (path === null) return fail("the bundle has a file without a name");
    files.push({ path, data });
  }
  return fail("the bundle archive has no end marker");
}
