import * as NodeDns from "node:dns";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import type * as Undici from "undici";

// The host itself, its neighbours on the link and cloud metadata endpoints. LAN and tailnet
// addresses stay allowed: self-hosted receivers such as n8n often live there.
const blocked = new NodeNet.BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4");
blocked.addAddress("255.255.255.255", "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");
blocked.addAddress("fd00:ec2::254", "ipv6");

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export const isBlockedCallbackAddress = (address: string): boolean => {
  const mapped = IPV4_MAPPED.exec(address)?.[1];
  if (mapped !== undefined) return blocked.check(mapped, "ipv4");
  const family = NodeNet.isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) return blocked.check(address, "ipv6");
  return true;
};

/** Why `url` cannot be a callback target, or undefined when it can. */
export const callbackUrlProblem = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "callback.url is not a URL.";
  }
  if (parsed.protocol !== "https:") return "callback.url must use https.";
  // Node connects to a literal IP without a lookup, so the guarded lookup never sees it.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (NodeNet.isIP(host) !== 0 && isBlockedCallbackAddress(host)) {
    return `callback.url points at ${host}, which callbacks may not reach.`;
  }
  return undefined;
};

/** Checks every address a callback connects to, so a DNS answer cannot redirect it to the host. */
const guardedLookup = ((
  hostname: string,
  options: NodeDns.LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | ReadonlyArray<NodeDns.LookupAddress>,
    family?: number,
  ) => void,
) => {
  NodeDns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) return callback(error, []);
    const refused = addresses.find((entry) => isBlockedCallbackAddress(entry.address));
    if (refused !== undefined || addresses.length === 0) {
      const reason = new Error(
        `${hostname} resolves to ${refused?.address ?? "nothing"}, which callbacks may not reach.`,
      ) as NodeJS.ErrnoException;
      reason.code = "ECALLBACKADDRESS";
      return callback(reason, []);
    }
    if (options.all === true) return callback(null, addresses);
    const [first] = addresses;
    return callback(null, first!.address, first!.family);
  });
}) as unknown as NodeNet.LookupFunction;

// undici is external to the CLI bundle; Node single-executables can load it from disk only with require.
const requireUndici = NodeModule.createRequire(import.meta.url);
let guardedFetch: typeof globalThis.fetch | undefined;

/**
 * A fetch whose connections only reach addresses `isBlockedCallbackAddress` allows. It is the npm
 * undici's own fetch: Node 22/24's built-in fetch rejects a dispatcher from a newer undici.
 */
export const callbackFetch = (): typeof globalThis.fetch => {
  if (guardedFetch === undefined) {
    const undici = requireUndici("undici") as typeof Undici;
    const dispatcher = new undici.Agent({ allowH2: false, connect: { lookup: guardedLookup } });
    guardedFetch = ((input: Parameters<typeof undici.fetch>[0], init?: Undici.RequestInit) =>
      undici.fetch(input, { ...init, dispatcher, redirect: "error" })) as unknown as typeof fetch;
  }
  return guardedFetch;
};
