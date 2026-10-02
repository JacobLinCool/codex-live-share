import { lookup as systemLookup, promises as dns, type LookupAddress, type LookupOptions } from 'node:dns';

/**
 * Quick-tunnel hostnames are brand new each time. If anything asks the OS for
 * one a moment before Cloudflare publishes it, the OS resolver caches the
 * NXDOMAIN well past its TTL. For *.trycloudflare.com we therefore ask DNS
 * servers directly (c-ares, then DNS over HTTPS), never the OS cache.
 */
export function isQuickTunnelHost(hostname: string): boolean {
  return hostname.endsWith('.trycloudflare.com');
}

export async function resolveFresh(hostname: string): Promise<string[]> {
  try {
    const addresses = await dns.resolve4(hostname);
    if (addresses.length) return addresses;
  } catch {
    // Fall through to DNS over HTTPS.
  }
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
  const addresses = (body.Answer ?? []).filter((answer) => answer.type === 1).map((answer) => answer.data);
  if (!addresses.length) throw new Error(`${hostname} does not resolve yet`);
  return addresses;
}

/** Drop-in `lookup` for sockets (ws, net, tls). */
export function tunnelAwareLookup(
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  if (!isQuickTunnelHost(hostname)) {
    systemLookup(hostname, options, callback as never);
    return;
  }
  resolveFresh(hostname).then(
    (addresses) => {
      if (options.all) callback(null, addresses.map((address) => ({ address, family: 4 })));
      else callback(null, addresses[0]!, 4);
    },
    () => systemLookup(hostname, options, callback as never),
  );
}

/** Resolves once the name is published, so an invite is never handed out before it works. */
export async function waitForDns(hostname: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await resolveFresh(hostname);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  return false;
}
