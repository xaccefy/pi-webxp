import { lookup as dnsLookupAsync } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicIpAddress } from "@xaccefy/pi-shared";

export function normalizeHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

export function isPublicHttpHost(parsed: URL): boolean {
  const host = normalizeHostname(parsed.hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  const family = isIP(host);
  return family === 0 ? true : isPublicIpAddress(host);
}

/** Reject private DNS answers before web_fetch submits a URL to the daemon. */
export async function assertPublicDns(hostname: string): Promise<void> {
  const host = normalizeHostname(hostname);
  if (isIP(host)) return;
  let addresses: { address: string; family: number }[] | undefined;
  try {
    addresses = await dnsLookupAsync(host, { all: true });
  } catch {
    return;
  }
  const blocked = addresses.find((entry) => !isPublicIpAddress(entry.address));
  if (blocked) {
    throw new Error(`Blocked: ${host} resolved to private/internal address ${blocked.address}`);
  }
}
