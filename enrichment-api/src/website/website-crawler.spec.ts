import { describe, expect, it } from 'vitest';
import type { PageFetch } from './safe-fetch.js';
import { WebsiteCrawler, websiteUrl } from './website-crawler.js';
import { loadWebsiteConfig } from './website.config.js';
import { WebsiteError } from './website.errors.js';

const TEXT = 'Example Corp builds widgets for manufacturers around the world. '.repeat(3);

function html(body: string, links: string[] = []): string {
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join(' ');
  return `<html><head><title>Example</title></head><body><nav>${anchors}</nav><main><p>${body}</p></main></body></html>`;
}

type Route = string | { status: number; location?: string; contentType?: string };

const SITE: Record<string, Route> = {
  'https://www.example.com/': html(`Home. ${TEXT}`, [
    '/blog/post-1',
    '/about',
    '/careers',
    '/login',
    '/files/report.pdf',
    '/internal',
    'https://other.example.org/about',
    'https://careers.example.com/jobs',
    'https://www.linkedin.com/company/example',
    'https://twitter.com/example',
    'https://www.facebook.com/sharer/sharer.php?u=x',
    'mailto:info@example.com',
  ]),
  'https://www.example.com/about': html(`About. ${TEXT}`, ['/about/team', '/']),
  'https://www.example.com/about/team': html(`Team. ${TEXT}`, ['/about/team/history']),
  'https://www.example.com/about/team/history': html(`History. ${TEXT}`),
  'https://www.example.com/careers': { status: 301, location: '/jobs' },
  'https://www.example.com/jobs': html(`Jobs. ${TEXT}`),
  'https://www.example.com/blog/post-1': html(`Post. ${TEXT}`),
  'https://www.example.com/internal': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
  'https://careers.example.com/jobs': html('Too short'),
};

function fakeSite(routes: Record<string, Route>) {
  const requested: string[] = [];
  const fetchPage: PageFetch = async (url) => {
    requested.push(url.href);
    await Promise.resolve();
    const route = routes[url.href];
    if (route === undefined) return new Response('Not found', { status: 404 });
    if (typeof route === 'string') return new Response(route, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const headers: Record<string, string> = { 'content-type': route.contentType ?? 'text/html' };
    if (route.location) headers.location = route.location;
    return new Response(null, { status: route.status, headers });
  };
  return { fetchPage, requested };
}

function crawler(fetchPage: PageFetch, env: Record<string, string> = {}) {
  return new WebsiteCrawler(loadWebsiteConfig(env), fetchPage);
}

const options = () => ({ deadline: Date.now() + 5000, signal: new AbortController().signal, correlationId: 'test' });

describe('WebsiteCrawler', () => {
  it('crawls the most relevant pages first, two links deep, on the same site only', async () => {
    const site = fakeSite(SITE);

    const crawl = await crawler(site.fetchPage).crawl('www.example.com', options());

    expect(crawl.pages.map((page) => page.url)).toEqual([
      'https://www.example.com/',
      'https://www.example.com/about',
      'https://www.example.com/jobs',
      'https://www.example.com/blog/post-1',
      'https://www.example.com/about/team',
    ]);
    expect(site.requested).not.toContain('https://www.example.com/login');
    expect(site.requested).not.toContain('https://www.example.com/files/report.pdf');
    expect(site.requested).not.toContain('https://other.example.org/about');
    expect(site.requested).not.toContain('https://www.example.com/about/team/history');
    expect(site.requested).not.toContain('http://169.254.169.254/latest/meta-data/');
    expect(site.requested).toContain('https://careers.example.com/jobs');
  });

  it('keeps the navigation on the home page only', async () => {
    const crawl = await crawler(fakeSite(SITE).fetchPage).crawl('https://www.example.com', options());

    expect(crawl.pages[0].markdown).toContain('/careers');
    expect(crawl.pages[1].markdown).not.toContain('/about/team');
  });

  it('collects the social profiles the site links to', async () => {
    const crawl = await crawler(fakeSite(SITE).fetchPage).crawl('www.example.com', options());

    expect([...crawl.socialProfiles]).toEqual([
      ['https://www.linkedin.com/company/example', 'https://www.example.com/'],
      ['https://x.com/example', 'https://www.example.com/'],
    ]);
  });

  it('stops at the page limit', async () => {
    const crawl = await crawler(fakeSite(SITE).fetchPage, { WEBSITE_MAX_PAGES: '2' }).crawl('www.example.com', options());

    expect(crawl.pages).toHaveLength(2);
  });

  it('follows the home page to the domain it redirects to', async () => {
    const site = fakeSite({
      'https://example.com/': { status: 301, location: 'https://www.example.net/en/' },
      'https://www.example.net/en/': html(`Home. ${TEXT}`, ['/en/about']),
      'https://www.example.net/en/about': html(`About. ${TEXT}`),
    });

    const crawl = await crawler(site.fetchPage).crawl('example.com', options());

    expect(crawl.pages.map((page) => page.url)).toEqual(['https://www.example.net/en/', 'https://www.example.net/en/about']);
  });

  it('shares the pages between the topics, shortest paths first', async () => {
    const site = fakeSite({
      'https://www.example.com/': html(`Home. ${TEXT}`, [
        '/solutions/a/partners',
        '/solutions/b/partners',
        '/solutions/c?utm_source=home',
        '/solutions/c',
        '/careers/open-roles',
        '/company',
      ]),
      'https://www.example.com/solutions/a/partners': html(`A. ${TEXT}`),
      'https://www.example.com/solutions/c': html(`C. ${TEXT}`),
      'https://www.example.com/careers/open-roles': html(`Roles. ${TEXT}`),
      'https://www.example.com/company': html(`Company. ${TEXT}`),
    });

    const crawl = await crawler(site.fetchPage, { WEBSITE_MAX_PAGES: '4' }).crawl('www.example.com', options());

    expect(crawl.pages.map((page) => page.url)).toEqual([
      'https://www.example.com/',
      'https://www.example.com/company',
      'https://www.example.com/solutions/c',
      'https://www.example.com/careers/open-roles',
    ]);
    expect(site.requested.filter((url) => url.includes('/solutions/c'))).toEqual(['https://www.example.com/solutions/c']);
  });

  it('skips the translations of the site', async () => {
    const site = fakeSite({
      'https://www.example.com/de-de/': html(`Home. ${TEXT}`, ['/de-de/about', '/en/about', '/fr/about', '/ai/products']),
      'https://www.example.com/de-de/about': html(`About. ${TEXT}`),
      'https://www.example.com/ai/products': html(`Products. ${TEXT}`),
    });

    const crawl = await crawler(site.fetchPage).crawl('www.example.com/de-de/', options());

    expect(crawl.pages.map((page) => page.url)).toEqual([
      'https://www.example.com/de-de/',
      'https://www.example.com/de-de/about',
      'https://www.example.com/ai/products',
    ]);
    expect(site.requested).not.toContain('https://www.example.com/en/about');
  });

  it('fails as blocked when the site refuses the crawler', async () => {
    const site = fakeSite({ 'https://www.example.com/': { status: 403 } });

    const error = await crawler(site.fetchPage).crawl('www.example.com', options()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WebsiteError);
    expect(error).toMatchObject({ code: 'blocked', details: { status: 403 } });
  });

  it('fails as upstream_unavailable when the home page has a server error', async () => {
    const site = fakeSite({ 'https://www.example.com/': { status: 503 } });

    const error = await crawler(site.fetchPage).crawl('www.example.com', options()).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'upstream_unavailable', details: { status: 503 } });
  });

  it('falls back to http when https cannot connect', async () => {
    const fetchPage: PageFetch = async (url) => {
      await Promise.resolve();
      if (url.protocol === 'https:') throw new TypeError('fetch failed');
      return new Response(html(`Home. ${TEXT}`), { headers: { 'content-type': 'text/html' } });
    };

    const crawl = await crawler(fetchPage).crawl('www.example.com', options());

    expect(crawl.pages.map((page) => page.url)).toEqual(['http://www.example.com/']);
  });

  it('falls back to the host without www when its certificate does not cover www, and stays on that host', async () => {
    const certificateError = new TypeError('fetch failed', { cause: Object.assign(new Error('altname'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
    const site = fakeSite({
      'https://example.com/': html(`Home. ${TEXT}`, ['https://www.example.com/about']),
      'https://example.com/about': html(`About. ${TEXT}`),
    });
    const fetchPage: PageFetch = (url, signal) =>
      url.hostname === 'www.example.com' ? Promise.reject(certificateError) : site.fetchPage(url, signal);

    const crawl = await crawler(fetchPage).crawl('www.example.com', options());

    expect(crawl.pages.map((page) => page.url)).toEqual(['https://example.com/', 'https://example.com/about']);
  });

  it('rejects websites that are not public', async () => {
    const error = await crawler(fakeSite(SITE).fetchPage).crawl('http://localhost:3000', options()).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'invalid_request' });
  });
});

describe('websiteUrl', () => {
  it.each([
    ['www.example.com', 'https://www.example.com/'],
    ['http://example.com/en', 'https://example.com/en'],
    ['https://example.com/#top', 'https://example.com/'],
  ])('starts %s at %s', (website, url) => {
    expect(websiteUrl(website)?.href).toBe(url);
  });

  it.each(['', 'not a website', '10.0.0.1', 'localhost'])('rejects %s', (website) => {
    expect(websiteUrl(website)).toBeUndefined();
  });
});
