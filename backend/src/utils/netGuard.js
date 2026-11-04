import dns from "node:dns/promises";
import net from "node:net";
import { env } from "../config/env.js";
import { AppError } from "./AppError.js";

/** Loopback, private, link-local and similar addresses that a public mail server never uses. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || /^fe[89ab]/.test(v6);
}

/**
 * User-entered mail hosts must not let the server probe its own network.
 * Enforced in production; development may point at a local test server.
 */
export async function assertPublicHost(host) {
  if (!env.isProd) return;
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new AppError(400, `Can't find the mail server "${host}". Check the host name.`);
  }
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new AppError(400, `"${host}" points to a private network address, which isn't allowed.`);
  }
}
