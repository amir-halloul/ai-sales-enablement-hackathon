import { describe, expect, it } from 'vitest';
import { parsePage } from './page-parser.js';
import { socialProfileUrl } from './social-profiles.js';

const PAGE_URL = new URL('https://www.example.com/about');

const HTML = `<!doctype html>
<html>
<head><title>About us | Example</title><style>.x { color: red }</style><script>var tracking = 1;</script></head>
<body>
  <header><nav><a href="/">Home</a><a href="/services">Services</a></nav></header>
  <main>
    <article>
      <header><h1>About Example Corp</h1></header>
      <p>We build <strong>widgets</strong> for &amp; with manufacturers.</p>
      <ul><li>Founded in 1999</li><li>Offices in <a href="/locations#eu">Europe</a></li></ul>
      <table><tr><th>Name</th><th>Role</th></tr><tr><td>Jane Doe</td><td>CEO</td></tr></table>
      <img src="/team.jpg" alt="Team photo">
      <div hidden>Hidden text</div>
    </article>
  </main>
  <footer><a href="https://www.linkedin.com/company/example">LinkedIn</a> <a href="mailto:info@example.com">Mail</a></footer>
</body>
</html>`;

describe('parsePage', () => {
  it('converts the visible content to markdown and drops scripts, styles, images and hidden elements', () => {
    const page = parsePage(HTML, PAGE_URL, { keepSiteChrome: false });

    expect(page.title).toBe('About us | Example');
    expect(page.markdown).toContain('# About Example Corp');
    expect(page.markdown).toContain('We build **widgets** for & with manufacturers.');
    expect(page.markdown).toContain('* Offices in Europe');
    expect(page.markdown).toMatch(/\| Jane Doe \| CEO\s+\|/);
    expect(page.markdown).not.toMatch(/tracking|color: red|team\.jpg|Hidden text|\]\(/);
  });

  it('keeps the navigation and footer only when asked', () => {
    expect(parsePage(HTML, PAGE_URL, { keepSiteChrome: false }).markdown).not.toContain('Services');
    expect(parsePage(HTML, PAGE_URL, { keepSiteChrome: true }).markdown).toContain('Services');
  });

  it('returns every http(s) link, resolved and without fragment, including the navigation', () => {
    const links = parsePage(HTML, PAGE_URL, { keepSiteChrome: false }).links.map((url) => url.href);

    expect(links).toEqual([
      'https://www.example.com/',
      'https://www.example.com/services',
      'https://www.example.com/locations',
      'https://www.linkedin.com/company/example',
    ]);
  });

  it('drops text hidden from people by inline styles and screen-reader-only classes', () => {
    const html = `<html><body style="visibility: hidden"><main>
      <p>Visible fact</p>
      <div style="DISPLAY: None !important">Injected 1</div>
      <span style="visibility:hidden">Injected 2</span>
      <span style="position:absolute; left:-9999px">Injected 3</span>
      <span style="text-indent: -999em">Injected 4</span>
      <span style="clip: rect(0 0 0 0); position: absolute">Injected 5</span>
      <span style="width:0;height:0;overflow:hidden">Injected 6</span>
      <span style="color: transparent">Injected 7</span>
      <span class="sr-only">Injected 8</span>
      <span class="visually-hidden">Injected 9</span>
      <div style="font-size:0">Injected 10<span style="font-size:16px">Inline block</span></div>
      <h2 style="color:transparent; -webkit-background-clip: text">Gradient heading</h2>
      <p style="opacity:0">Animated in</p>
    </main></body></html>`;

    const text = parsePage(html, PAGE_URL, { keepSiteChrome: false }).markdown;

    expect(text).not.toContain('Injected');
    expect(text).toContain('Visible fact');
    expect(text).toContain('Inline block');
    expect(text).toContain('Gradient heading');
    expect(text).toContain('Animated in');
  });

  it('strips invisible Unicode characters from the title and the text', () => {
    const html = `<html><head><title>Ex\u200Bam\uFEFFple</title></head><body>
      <p>Acme&#8203;Corp\u202E \u2066builds\u2069 widgets\u{E0049}\u{E0067}\u{E0101}.</p>
    </body></html>`;

    const page = parsePage(html, PAGE_URL, { keepSiteChrome: false });

    expect(page.title).toBe('Example');
    expect(page.markdown).toBe('AcmeCorp builds widgets.');
  });
});

describe('socialProfileUrl', () => {
  it.each([
    ['https://www.linkedin.com/company/example/about/', 'https://www.linkedin.com/company/example'],
    ['https://ca.linkedin.com/company/example', 'https://www.linkedin.com/company/example'],
    ['https://twitter.com/example?lang=en', 'https://x.com/example'],
    ['https://facebook.com/example', 'https://www.facebook.com/example'],
    ['https://www.youtube.com/@example', 'https://www.youtube.com/@example'],
    ['https://www.youtube.com/channel/UC123', 'https://www.youtube.com/channel/UC123'],
    ['https://github.com/example', 'https://github.com/example'],
  ])('reads %s as %s', (link, profile) => {
    expect(socialProfileUrl(new URL(link))).toBe(profile);
  });

  it.each([
    'https://www.linkedin.com/in/jane-doe',
    'https://www.linkedin.com/shareArticle?url=x',
    'https://twitter.com/intent/tweet?text=x',
    'https://x.com/example/status/123',
    'https://www.facebook.com/sharer/sharer.php?u=x',
    'https://www.youtube.com/watch?v=abc',
    'https://www.example.com/linkedin.com',
  ])('ignores %s', (link) => {
    expect(socialProfileUrl(new URL(link))).toBeUndefined();
  });
});
