import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

// Company websites come from third-party data, so every request must stay on the public internet (no SSRF).

/** Fetches one URL without following redirects: the caller checks every hop with isAllowedUrl. */
export type PageFetch = (url: URL, signal: AbortSignal) => Promise<Response>;

const USER_AGENT = 'Mozilla/5.0 (compatible; EnrichmentAPI/1.0)';
const CONNECT_TIMEOUT_MS = 5_000;

const PRIVATE_RANGES: [network: string, prefix: number, type: 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  // No ::ffff:0:0/96 rule: BlockList already checks IPv4-mapped addresses against the IPv4 rules.
  ['64:ff9b::', 96, 'ipv6'],
  ['2001::', 32, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
];

const BLOCKED = new BlockList();
for (const [network, prefix, type] of PRIVATE_RANGES) BLOCKED.addSubnet(network, prefix, type);

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** http(s) on the default port, no credentials, and no private IP literal or single-label host such as "localhost". */
export function isAllowedUrl(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password || url.port) return false;
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isIP(host)) return isPublicAddress(host);
  return host.includes('.');
}

/** Resolves like dns.lookup but fails when any address of the host is not public, so DNS cannot point inside. */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '');
      return;
    }
    if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
      callback(Object.assign(new Error(`${hostname} does not resolve to a public address`), { code: 'EBLOCKED' }), '');
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

export function createPublicPageFetch(): PageFetch {
  const dispatcher = new Agent({ connect: { lookup: publicOnlyLookup, timeout: CONNECT_TIMEOUT_MS } });
  return (url, signal) =>
    undiciFetch(url, {
      dispatcher,
      signal,
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'accept-language': 'en' },
    });
}
