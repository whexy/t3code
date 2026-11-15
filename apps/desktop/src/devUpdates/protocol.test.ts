// @effect-diagnostics nodeBuiltinImport:off -- Tests sign with a generated RSA key and read the shipped certificates.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import * as Protocol from "./protocol.ts";

const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const sign = (body: string, keyId = "main") =>
  `sig="${NodeCrypto.sign("sha256", Buffer.from(body), privateKey).toString("base64")}", keyid="${keyId}", alg="rsa-v1_5-sha256"`;

const BOUNDARY = "b0undary";

// Shaped like the OTA server's Go multipart writer: lowercase part headers, CRLF lines.
function multipart(parts: ReadonlyArray<{ name: string; body: string; signature?: string }>) {
  const chunks = parts.map(
    ({ name, body, signature }) =>
      `--${BOUNDARY}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-disposition: form-data; name="${name}"\r\n${signature === undefined ? "" : `expo-signature: ${signature}\r\n`}\r\n${body}\r\n`,
  );
  return new TextEncoder().encode(`${chunks.join("")}--${BOUNDARY}--\r\n`);
}

const manifestBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "0193a9e2-7d1c-7c3e-9f00-5d2a1b3c4d5e",
    createdAt: "2026-11-15T08:00:00.000Z",
    runtimeVersion: "0.1.10-nightly.20261113.4656.20261114020203",
    launchAsset: {
      hash: "abc",
      key: "bundle",
      contentType: "application/gzip",
      fileExtension: "tgz",
      url: "https://ota.clusters.work/t3code/assets/abc.tgz",
    },
    assets: [],
    metadata: { gitCommit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" },
    extra: {},
    ...overrides,
  });

const read = (body: Uint8Array, status = 200) =>
  Protocol.readManifestResponse({
    status,
    contentType: `multipart/mixed; boundary=${BOUNDARY}`,
    body,
    publicKey,
  });

describe("parseMultipartMixed", () => {
  it("splits parts and keeps their exact bytes", () => {
    const parts = Protocol.parseMultipartMixed(
      `multipart/mixed; boundary="${BOUNDARY}"`,
      multipart([
        { name: "manifest", body: '{"a":"\r\n"}', signature: "sig=x" },
        { name: "extensions", body: "{}" },
      ]),
    );
    expect(parts.map(Protocol.multipartPartName)).toEqual(["manifest", "extensions"]);
    expect(new TextDecoder().decode(parts[0]?.body)).toBe('{"a":"\r\n"}');
    expect(parts[0]?.headers.get("expo-signature")).toBe("sig=x");
  });

  it.each([
    ["application/json", multipart([])],
    [`multipart/mixed; boundary=${BOUNDARY}`, new TextEncoder().encode(`--${BOUNDARY}\r\nx`)],
  ])("rejects %s bodies it cannot split", (contentType, body) => {
    expect(() => Protocol.parseMultipartMixed(contentType, body)).toThrow(
      Protocol.DevUpdateProtocolError,
    );
  });
});

describe("readManifestResponse", () => {
  it("reads a signed manifest", () => {
    const body = manifestBody();
    const response = read(multipart([{ name: "manifest", body, signature: sign(body) }]));
    expect(response._tag).toBe("Update");
    if (response._tag === "Update") {
      expect(response.manifest.metadata?.gitCommit).toBe(
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      );
    }
  });

  it.each([
    ["rollBackToEmbedded", "RollBackToEmbedded"],
    ["noUpdateAvailable", "NoUpdate"],
  ])("reads a signed %s directive", (type, tag) => {
    const body = JSON.stringify({ type, parameters: { commitTime: "2026-11-15T08:00:00.000Z" } });
    expect(read(multipart([{ name: "directive", body, signature: sign(body) }]))._tag).toBe(tag);
  });

  it.each([
    ["unsigned", manifestBody(), undefined],
    ["tampered", manifestBody({ id: "other" }), sign(manifestBody())],
    ["signed by another key id", manifestBody(), sign(manifestBody(), "other")],
    [
      "signed by another key",
      manifestBody(),
      `sig="${NodeCrypto.sign(
        "sha256",
        Buffer.from(manifestBody()),
        NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
      ).toString("base64")}", keyid="main", alg="rsa-v1_5-sha256"`,
    ],
  ])("refuses a %s manifest", (_label, body, signature) => {
    expect(() =>
      read(
        multipart([
          signature === undefined
            ? { name: "manifest", body }
            : { name: "manifest", body, signature },
        ]),
      ),
    ).toThrow(Protocol.DevUpdateProtocolError);
  });

  it.each([
    ["an id that is not a directory name", { id: "../escape" }],
    [
      "a bundle URL that is not https",
      {
        launchAsset: {
          hash: "abc",
          key: "bundle",
          contentType: "application/gzip",
          url: "http://ota.clusters.work/t3code/assets/abc.tgz",
        },
      },
    ],
  ])("refuses a signed manifest with %s", (_label, overrides) => {
    const body = manifestBody(overrides);
    expect(() => read(multipart([{ name: "manifest", body, signature: sign(body) }]))).toThrow(
      Protocol.DevUpdateProtocolError,
    );
  });
});

describe("verifyAssetHash", () => {
  const data = new TextEncoder().encode("bundle bytes");
  const hash = NodeCrypto.createHash("sha256").update(data).digest("base64url");

  it("accepts the base64url sha256", () => {
    expect(() => Protocol.verifyAssetHash(data, hash)).not.toThrow();
  });

  it("refuses other bytes", () => {
    expect(() => Protocol.verifyAssetHash(new TextEncoder().encode("other bytes"), hash)).toThrow(
      Protocol.DevUpdateProtocolError,
    );
  });
});

function tarEntry(name: string, data: string, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${Buffer.byteLength(data).toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.fill(" ", 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512);
  body.write(data);
  return Buffer.concat([header, body]);
}

const tar = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);

describe("readTar", () => {
  it("reads files under the archive root as tar -C dir . writes them", () => {
    const files = Protocol.readTar(
      tar(
        tarEntry("./", "", "5"),
        tarEntry("./index.html", "<html>"),
        tarEntry("./assets/", "", "5"),
        tarEntry("./assets/index.js", "x".repeat(700)),
      ),
    );
    expect(files.map((file) => [file.path, file.data.length])).toEqual([
      ["index.html", 6],
      ["assets/index.js", 700],
    ]);
  });

  it.each([
    ["a parent path", tarEntry("../index.html", "x")],
    ["an absolute path", tarEntry("/etc/passwd", "x")],
    ["a symlink", tarEntry("./index.html", "", "2")],
  ])("refuses %s", (_label, entry) => {
    expect(() => Protocol.readTar(tar(entry))).toThrow(Protocol.DevUpdateProtocolError);
  });

  it("refuses a truncated archive", () => {
    expect(() =>
      Protocol.readTar(tarEntry("./index.html", "x".repeat(700)).subarray(0, 800)),
    ).toThrow(Protocol.DevUpdateProtocolError);
  });
});

it("ships the certificate the fork's iOS app verifies with", () => {
  const desktop = NodeFS.readFileSync(
    new URL("../../resources/forkOtaCertificate.pem", import.meta.url),
    "utf8",
  );
  const mobile = NodeFS.readFileSync(
    new URL("../../../mobile/forkOtaCertificate.pem", import.meta.url),
    "utf8",
  );
  expect(desktop).toBe(mobile);
  expect(Protocol.publicKeyFromCertificate(desktop).asymmetricKeyType).toBe("rsa");
});
