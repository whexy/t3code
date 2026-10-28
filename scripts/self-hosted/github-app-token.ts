// Prints an installation token for the GitHub App named by GITHUB_APP_ID,
// GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY. The self-hosted sync
// pipeline pushes the rebased branch with it.
import * as NodeCrypto from "node:crypto";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
// GitHub rejects an `iat` ahead of its clock, so back-date it for skew.
const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: env("GITHUB_APP_ID") })}`;
const jwt = `${unsigned}.${NodeCrypto.sign("sha256", Buffer.from(unsigned), env("GITHUB_APP_PRIVATE_KEY")).toString("base64url")}`;

const response = await fetch(
  `https://api.github.com/app/installations/${env("GITHUB_APP_INSTALLATION_ID")}/access_tokens`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
  },
);
if (!response.ok) {
  throw new Error(`GitHub answered ${response.status}: ${await response.text()}`);
}
const { token } = (await response.json()) as { token: string };
console.log(token);
