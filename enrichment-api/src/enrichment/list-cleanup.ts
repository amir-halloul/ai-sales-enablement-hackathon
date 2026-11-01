import type { AttributedValue, NewsHeadline } from './enrichment.types.js';

// Deterministic rules applied to the merged lists, before the optional AI consolidation.

/** Older news no longer describes the entity's current situation. */
const MAX_NEWS_AGE_MONTHS = 24;

/** Category words that name no specific product, compared after textKey(), e.g. ZoomInfo's "Services". */
const GENERIC_PRODUCT_NAMES = new Set([
  'product',
  'products',
  'service',
  'services',
  'solution',
  'solutions',
  'offering',
  'offerings',
  'other',
  'others',
  'misc',
  'miscellaneous',
  'various',
  'n a',
  'na',
  'none',
  'unknown',
]);

/** Drops news older than MAX_NEWS_AGE_MONTHS; undated news is kept. */
export function cleanNews(news: NewsHeadline[], today = new Date()): NewsHeadline[] {
  const cutoff = monthsBefore(today, MAX_NEWS_AGE_MONTHS);
  return sortNewestFirst(news.filter((item) => item.date === null || item.date >= cutoff));
}

/** Undated news comes last, in its original order. */
export function sortNewestFirst(news: NewsHeadline[]): NewsHeadline[] {
  return [...news].sort((a, b) => {
    if (a.date === b.date) return 0;
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return b.date.localeCompare(a.date);
  });
}

/** Drops entries that name no product: generic category words, the company's own name, or text without letters. */
export function cleanProducts(products: AttributedValue<string>[], companyName: string | undefined): AttributedValue<string>[] {
  const companyKey = companyName === undefined ? undefined : textKey(companyName);
  return products.filter((item) => isMeaningfulProduct(item.value, companyKey));
}

function isMeaningfulProduct(name: string, companyKey: string | undefined): boolean {
  const key = textKey(name);
  const letters = key.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return false;
  if (GENERIC_PRODUCT_NAMES.has(key)) return false;
  return key !== companyKey;
}

/** "Example Corp acquires Widget, Inc." and "Example Corp Acquires Widget Inc" are the same story. */
export function headlineKey(headline: string): string {
  return textKey(headline);
}

/** "Cloud-Services" and "cloud service" are the same product; "&" and "and" too. */
export function productKey(name: string): string {
  return textKey(name.replace(/&/g, ' and '))
    .split(' ')
    .map(singular)
    .join(' ');
}

/** Lower case, with punctuation and quotes turned into single spaces. */
function textKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Crude, but applied to both sides of a comparison: "services" and "service" match, "business" stays. */
function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function monthsBefore(today: Date, months: number): string {
  const date = new Date(today);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}
