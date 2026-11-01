const ALIASES: Record<string, string> = {
  US: 'US',
  USA: 'US',
  'U.S.': 'US',
  'U.S.A.': 'US',
  'UNITED STATES OF AMERICA': 'US',
  UK: 'GB',
  'U.K.': 'GB',
  'GREAT BRITAIN': 'GB',
  ENGLAND: 'GB',
};

const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
const CODES_BY_NAME = codesByName();

/** "Redmond, WA 98052, United States" gives "US". Two-letter codes other than US and UK are not accepted: "CA" may be California. */
export function countryCodeOf(address: string | undefined): string | undefined {
  const last = address?.split(',').at(-1)?.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!last) return undefined;
  return ALIASES[last] ?? CODES_BY_NAME.get(last);
}

/** "US" becomes "United States", the form ZoomInfo uses. */
export function countryName(code: string | undefined): string | undefined {
  return code ? (regionNames.of(code) ?? code) : undefined;
}

/** Maps upper-case English country names to ISO codes, e.g. "NETHERLANDS" to "NL". */
function codesByName(): Map<string, string> {
  const codes = new Map<string, string>();
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const first of letters) {
    for (const second of letters) {
      const code = first + second;
      const name = regionNames.of(code);
      if (name) codes.set(name.toUpperCase(), code);
    }
  }
  return codes;
}
