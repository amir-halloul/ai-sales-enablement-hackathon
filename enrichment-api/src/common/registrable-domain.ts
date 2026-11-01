import { getDomain } from 'tldts';

/** "https://shop.example.co.uk/about" becomes "example.co.uk"; sites on shared hosts keep their own name (e.g. "acme.github.io"). */
export function registrableDomain(website: string | undefined): string | undefined {
  const raw = website?.trim();
  if (!raw) return undefined;
  return getDomain(raw, { allowPrivateDomains: true }) ?? undefined;
}

/** "www.example.com" and "test.example.com" are the same site; a missing or invalid website matches nothing. */
export function sameRegistrableDomain(a: string | undefined, b: string | undefined): boolean {
  const domain = registrableDomain(a);
  return domain !== undefined && domain === registrableDomain(b);
}
