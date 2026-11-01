import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { TextDecoder } from 'node:util';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sourceKey } from '../web-search/web-search.client.js';
import { parsePage } from './page-parser.js';
import { isAllowedUrl, type PageFetch } from './safe-fetch.js';
import { socialProfileUrl } from './social-profiles.js';
import { WEBSITE_CONFIG, WEBSITE_PAGE_FETCH, type WebsiteConfig } from './website.config.js';
import { WebsiteError, type WebsiteErrorCode } from './website.errors.js';

const MAX_DEPTH = 2;
const CONCURRENCY = 5;
const PAGE_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2_000_000;
const MAX_PAGE_CHARS = 20_000;
/** About 50k tokens, which leaves the model time to answer within the request budget. */
const MAX_TOTAL_CHARS = 200_000;
/** Pages with less text are not kept, e.g. pages rendered by JavaScript, but their links are still followed. */
const MIN_PAGE_CHARS = 100;
const HTML_CONTENT_TYPE = /^\s*(?:text\/html|application\/xhtml\+xml)\b/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Topics the crawl looks for; each gets a share of the pages in proportion to its weight. */
const KEYWORD_GROUPS: { weight: number; keywords: string[] }[] = [
  { weight: 1.0, keywords: ['about', 'company', 'overview', 'history', 'leadership', 'team', 'location', 'contact'] },
  { weight: 1.0, keywords: ['service', 'solution', 'product', 'offering', 'industr', 'expertise', 'capabilit'] },
  { weight: 0.9, keywords: ['career', 'job', 'hiring', 'vacanc', 'recruit', 'employment', 'culture'] },
  { weight: 0.8, keywords: ['technolog', 'engineering', 'platform', 'integration', 'infrastructure', 'research', 'partner'] },
  { weight: 0.8, keywords: ['news', 'press', 'media', 'announcement', 'acquisition', 'funding', 'investor', 'award'] },
  { weight: 0.3, keywords: ['insight', 'blog', 'resource', 'case-stud', 'customer', 'report', 'publication', 'event'] },
];
/** Pages that match no topic, crawled when the topics run out. */
const OTHER_TOPIC = KEYWORD_GROUPS.length;
const OTHER_WEIGHT = 0.2;
const TRACKING_PARAM = /^(?:utm_\w+|_ga|_gac|_gl|gclid|fbclid|msclkid|mc_cid|mc_eid|hsa_\w+)$/i;

const EXCLUDED_PATH =
  /(?:^|\/)(?:login|log-in|signin|sign-in|logout|log-out|signup|sign-up|password-reset|reset-password|cart|checkout|unsubscribe|privacy-policy|cookie-policy|terms-of-use|terms-and-conditions)(?:\.html?)?\/?$/i;
const NON_HTML_PATH = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|css|js|json|xml|txt|csv|zip|gz|mp3|mp4|mov|avi|docx?|xlsx?|pptx?)$/i;
/** A first path segment such as "de", "pt-br" or "zh_cn": the site's translations repeat the same pages. */
const LOCALE_SEGMENT = /^([a-z]{2})(?:[-_][a-z]{2,4})?$/i;
const LANGUAGES = new Set(
  ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'ja', 'ko', 'zh', 'ru', 'pl', 'sv', 'da', 'fi', 'no', 'nb', 'tr', 'ar', 'he', 'cs', 'hu', 'ro', 'el', 'th', 'vi', 'id', 'uk'],
);

export interface CrawledPage {
  url: string;
  title: string | null;
  markdown: string;
}

export interface WebsiteCrawl {
  pages: CrawledPage[];
  /** Profile URL → the first crawled page that links to it. */
  socialProfiles: Map<string, string>;
}

export interface CrawlOptions {
  /** Absolute deadline (epoch ms); the crawl also stops at the configured crawl timeout. */
  deadline: number;
  signal: AbortSignal;
  correlationId?: string;
}

type FetchResult = { url: URL; html: string } | { url: URL; failure: string; status?: number; cause?: string };

interface Candidate {
  url: URL;
  depth: number;
  segments: number;
}

/**
 * Crawls a company website up to two links away from the home page, sharing the pages between the topics that
 * describe the company (about, services, careers, news...). Plain HTTP only: no JavaScript rendering.
 */
@Injectable()
export class WebsiteCrawler {
  private readonly logger = new Logger('Website');

  constructor(
    @Inject(WEBSITE_CONFIG) private readonly config: WebsiteConfig,
    @Inject(WEBSITE_PAGE_FETCH) private readonly fetchPage: PageFetch,
  ) {}

  async crawl(website: string, options: CrawlOptions): Promise<WebsiteCrawl> {
    const started = Date.now();
    const start = websiteUrl(website);
    if (!start) throw new WebsiteError('invalid_request', { operation: 'crawl' });
    const deadline = Math.min(options.deadline, started + this.config.crawlTimeoutMs);

    const home = await this.fetchHome(start, deadline, options.signal);
    if ('failure' in home) {
      this.log('warn', 'home_failed', {
        url: home.url.href,
        failure: home.failure,
        status: home.status,
        cause: home.cause,
        correlationId: options.correlationId,
      });
      throw new WebsiteError(failureCode(home, options.signal), { operation: 'crawl', status: home.status });
    }

    const crawl = new Crawl(start, home.url);
    crawl.addPage(home, 0);
    while (crawl.pages.length < this.config.maxPages && !crawl.textBudgetSpent() && Date.now() < deadline) {
      const batch = crawl.frontier.take(Math.min(CONCURRENCY, this.config.maxPages - crawl.pages.length));
      if (batch.length === 0) break;
      const results = await Promise.all(batch.map((candidate) => this.fetchHtml(candidate.url, deadline, options.signal)));
      if (options.signal.aborted) throw new WebsiteError('cancelled', { operation: 'crawl' });
      results.forEach((result, i) => this.addResult(crawl, result, batch[i].depth, options.correlationId));
    }

    this.log('debug', 'crawl_ok', {
      url: start.href,
      pages: crawl.pages.length,
      chars: crawl.chars,
      socialProfiles: crawl.socialProfiles.size,
      durationMs: Date.now() - started,
      correlationId: options.correlationId,
    });
    return { pages: crawl.pages, socialProfiles: crawl.socialProfiles };
  }

  /**
   * Falls back to the host with or without "www." (some certificates cover only one of them), then to plain http
   * for the sites that still do not serve https.
   */
  private async fetchHome(start: URL, deadline: number, signal: AbortSignal): Promise<FetchResult> {
    const twin = new URL(start);
    twin.hostname = wwwTwin(start.hostname);
    const http = new URL(start);
    http.protocol = 'http:';

    let result = await this.fetchHtml(start, deadline, signal);
    for (const fallback of [twin, http]) {
      if (!('failure' in result) || result.failure !== 'network_error') break;
      this.log('debug', 'home_retry', { url: result.url.href, cause: result.cause, next: fallback.href });
      result = await this.fetchHtml(fallback, deadline, signal);
    }
    return result;
  }

  private addResult(crawl: Crawl, result: FetchResult, depth: number, correlationId: string | undefined): void {
    if ('failure' in result) {
      this.log('debug', 'page_failed', { url: result.url.href, failure: result.failure, status: result.status, cause: result.cause, correlationId });
      return;
    }
    crawl.addPage(result, depth);
  }

  /** Follows redirects itself, so that every hop goes through the SSRF check. */
  private async fetchHtml(url: URL, deadline: number, signal: AbortSignal): Promise<FetchResult> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { url, failure: 'timeout' };
    const pageSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(PAGE_TIMEOUT_MS, remaining))]);
    let current = url;
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        if (!isAllowedUrl(current)) return { url: current, failure: 'blocked_url' };
        const response = await this.fetchPage(current, pageSignal);
        const location = redirectLocation(response, current);
        if (location) {
          await discard(response);
          current = location;
          continue;
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!response.ok) {
          await discard(response);
          return { url: current, failure: 'http_error', status: response.status };
        }
        if (!HTML_CONTENT_TYPE.test(contentType)) {
          await discard(response);
          return { url: current, failure: 'not_html' };
        }
        return { url: current, html: await readHtml(response, contentType) };
      }
      return { url: current, failure: 'too_many_redirects' };
    } catch (error) {
      if (pageSignal.aborted) return { url: current, failure: 'timeout' };
      return { url: current, failure: 'network_error', cause: errorCause(error) };
    }
  }

  private log(level: 'debug' | 'warn', event: string, fields: Record<string, string | number | undefined>): void {
    this.logger[level]({ event: `website.${event}`, ...fields });
  }
}

/** The state of one crawl. */
class Crawl {
  readonly pages: CrawledPage[] = [];
  readonly socialProfiles = new Map<string, string>();
  readonly frontier = new Frontier();
  chars = 0;
  private readonly site: Site;
  private readonly crawled = new Set<string>();
  /** The home page's locale segment; English when the home page has none. */
  private readonly locale: string;

  private readonly homeHost: string;

  constructor(start: URL, home: URL) {
    this.site = new Site([start, home]);
    this.homeHost = home.hostname;
    this.locale = localeOf(home) ?? 'en';
    this.frontier.markSeen(start);
    this.frontier.markSeen(home);
  }

  textBudgetSpent(): boolean {
    return this.chars > MAX_TOTAL_CHARS - MIN_PAGE_CHARS;
  }

  addPage(fetched: { url: URL; html: string }, depth: number): void {
    const key = sourceKey(fetched.url.href);
    // A redirect may lead off the site or to a page already crawled.
    if (key === undefined || this.crawled.has(key) || !this.site.contains(fetched.url)) return;
    this.crawled.add(key);

    const page = parsePage(fetched.html, fetched.url, { keepSiteChrome: depth === 0 });
    for (const link of page.links) this.addLink(link, fetched.url, depth);

    const markdown = page.markdown.slice(0, Math.min(MAX_PAGE_CHARS, MAX_TOTAL_CHARS - this.chars));
    if (markdown.length < MIN_PAGE_CHARS) return;
    this.pages.push({ url: fetched.url.href, title: page.title, markdown });
    this.chars += markdown.length;
  }

  private addLink(link: URL, pageUrl: URL, depth: number): void {
    const profile = socialProfileUrl(link);
    if (profile) {
      if (!this.socialProfiles.has(profile)) this.socialProfiles.set(profile, pageUrl.href);
      return;
    }
    if (depth < MAX_DEPTH && this.shouldVisit(link)) this.frontier.add(this.onHomeHost(withoutTracking(link)), depth + 1);
  }

  /** Links to the home's host with or without "www." go to the home's host, which is known to work. */
  private onHomeHost(url: URL): URL {
    if (url.hostname !== wwwTwin(this.homeHost)) return url;
    const moved = new URL(url);
    moved.hostname = this.homeHost;
    return moved;
  }

  private shouldVisit(url: URL): boolean {
    if (!this.site.contains(url) || !isAllowedUrl(url)) return false;
    if (EXCLUDED_PATH.test(url.pathname) || NON_HTML_PATH.test(url.pathname)) return false;
    const locale = localeOf(url);
    return locale === undefined || locale === this.locale;
  }
}

function localeOf(url: URL): string | undefined {
  const segment = url.pathname.split('/')[1] ?? '';
  const language = LOCALE_SEGMENT.exec(segment)?.[1].toLowerCase();
  if (language === undefined || !LANGUAGES.has(language)) return undefined;
  return segment.toLowerCase().replace('_', '-');
}

/** The pages waiting to be crawled, by topic. */
class Frontier {
  private readonly topics: Candidate[][] = Array.from({ length: OTHER_TOPIC + 1 }, () => []);
  private readonly taken: number[] = new Array<number>(OTHER_TOPIC + 1).fill(0);
  private readonly seen = new Set<string>();

  add(url: URL, depth: number): void {
    const key = sourceKey(url.href);
    if (key === undefined || this.seen.has(key)) return;
    this.seen.add(key);
    this.topics[topicOf(url)].push({ url, depth, segments: url.pathname.split('/').filter(Boolean).length });
  }

  markSeen(url: URL): void {
    const key = sourceKey(url.href);
    if (key !== undefined) this.seen.add(key);
  }

  /** Takes from the topics in turn, in proportion to their weights; within a topic, the shortest paths first. */
  take(count: number): Candidate[] {
    const batch: Candidate[] = [];
    for (let topic = this.nextTopic(); topic !== undefined && batch.length < count; topic = this.nextTopic()) {
      const queue = this.topics[topic];
      queue.sort((a, b) => a.segments - b.segments || a.depth - b.depth);
      batch.push(...queue.splice(0, 1));
      this.taken[topic]++;
    }
    return batch;
  }

  private nextTopic(): number | undefined {
    let next: number | undefined;
    let nextTurn = Infinity;
    this.topics.forEach((queue, topic) => {
      const turn = (this.taken[topic] + 1) / topicWeight(topic);
      if (queue.length > 0 && turn < nextTurn) {
        next = topic;
        nextTurn = turn;
      }
    });
    return next;
  }
}

/** The website's domains and their subdomains, such as careers.example.com; "www." does not matter. */
class Site {
  private readonly domains: string[];

  constructor(urls: URL[]) {
    this.domains = [...new Set(urls.map(bareHost))];
  }

  contains(url: URL): boolean {
    const host = bareHost(url);
    return this.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  }
}

function bareHost(url: URL): string {
  return url.hostname.replace(/^www\./, '');
}

/** "www.example.com" for "example.com", and the other way round. */
function wwwTwin(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : `www.${hostname}`;
}

/** The error code behind a failed fetch, e.g. ENOTFOUND or ERR_TLS_CERT_ALTNAME_INVALID; never the page content. */
function errorCause(error: unknown): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** The first topic whose keywords appear in the URL path. */
function topicOf(url: URL): number {
  const path = url.pathname.toLowerCase();
  const topic = KEYWORD_GROUPS.findIndex((group) => group.keywords.some((keyword) => path.includes(keyword)));
  return topic === -1 ? OTHER_TOPIC : topic;
}

function topicWeight(topic: number): number {
  return topic === OTHER_TOPIC ? OTHER_WEIGHT : KEYWORD_GROUPS[topic].weight;
}

/** Links often carry analytics parameters, which would make the same page look like several. */
function withoutTracking(url: URL): URL {
  const clean = new URL(url);
  for (const name of [...clean.searchParams.keys()]) {
    if (TRACKING_PARAM.test(name)) clean.searchParams.delete(name);
  }
  return clean;
}

/** The https URL to start crawling from; websites from data providers often lack the scheme ("www.example.com"). */
export function websiteUrl(website: string): URL | undefined {
  const withoutScheme = website.trim().replace(/^https?:\/\//i, '');
  let url: URL;
  try {
    url = new URL(`https://${withoutScheme}`);
  } catch {
    return undefined;
  }
  url.hash = '';
  return isAllowedUrl(url) ? url : undefined;
}

function redirectLocation(response: Response, current: URL): URL | undefined {
  if (!REDIRECT_STATUSES.has(response.status)) return undefined;
  const location = response.headers.get('location');
  if (!location) return undefined;
  try {
    return new URL(location, current);
  } catch {
    return undefined;
  }
}

function failureCode(home: { failure: string; status?: number }, signal: AbortSignal): WebsiteErrorCode {
  if (signal.aborted) return 'cancelled';
  if (home.failure === 'timeout') return 'timeout';
  if (home.failure === 'blocked_url') return 'invalid_request';
  if (home.status === 401 || home.status === 403) return 'blocked';
  return 'upstream_unavailable';
}

async function readHtml(response: Response, contentType: string): Promise<string> {
  const bytes = await readCapped(response, MAX_HTML_BYTES);
  return decoderFor(contentType).decode(bytes);
}

/** Pages over the cap are cut, not rejected: the start of the page is still useful. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size >= maxBytes) await reader.cancel();
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

function decoderFor(contentType: string): TextDecoder {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
