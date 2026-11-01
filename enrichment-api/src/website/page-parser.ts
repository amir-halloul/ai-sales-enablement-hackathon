import { NodeHtmlMarkdown } from 'node-html-markdown';
import { NodeType, parse, type HTMLElement } from 'node-html-parser';

export interface ParsedPage {
  title: string | null;
  /** The visible text as markdown: headings, lists and tables survive, links and images do not. */
  markdown: string;
  /** Every http(s) link on the page, including the navigation and footer, without fragments. */
  links: URL[];
}

const NOISE = 'script, style, noscript, template, svg, iframe, canvas, [hidden], [aria-hidden="true"]';
/** Navigation, header and footer repeat on every page, so they are kept on the home page only. */
const SITE_CHROME = 'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]';
const PAGE_CONTENT = 'main, article, [role="main"]';
/** Screen-reader-only classes of common CSS frameworks: never shown on screen. */
const SCREEN_READER_ONLY = '.sr-only, .visually-hidden, .visuallyhidden, .screen-reader-text, .element-invisible';

/** Render as nothing but can smuggle instructions: zero-width, bidi and tag characters, variation selectors, Hangul fillers. */
const INVISIBLE_CHARACTERS = /(?![\t\n\r])\p{Cc}|\p{Cf}|\p{Variation_Selector}|\u115F|\u1160|\u3164|\uFFA0/gu;
const ZERO_LENGTH = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?$/;
const FAR_NEGATIVE = /^-\d{3,}/;

const markdown = new NodeHtmlMarkdown(
  { maxConsecutiveNewlines: 2 },
  // Link targets and image URLs only cost tokens: keep the link text and drop images.
  { a: {}, img: { ignore: true } },
);

export function parsePage(html: string, pageUrl: URL, { keepSiteChrome }: { keepSiteChrome: boolean }): ParsedPage {
  const root = parse(html);
  const title = stripInvisibleCharacters(root.querySelector('title')?.text ?? '').trim() || null;
  const links = pageLinks(root, pageUrl);

  for (const element of root.querySelectorAll(NOISE)) element.remove();
  removeCssHiddenContent(root);
  if (!keepSiteChrome) removeSiteChrome(root);

  const body = root.querySelector('body') ?? root;
  const text = stripInvisibleCharacters(markdown.translate(body.innerHTML));
  return { title, markdown: text.trim(), links };
}

function stripInvisibleCharacters(text: string): string {
  return text.replace(INVISIBLE_CHARACTERS, '');
}

/**
 * Removes text that inline styles hide from people, a common place for injected instructions.
 * Rules in stylesheets are not evaluated: tabs and accordions use them for content that is shown on click.
 */
function removeCssHiddenContent(root: HTMLElement): void {
  for (const element of root.querySelectorAll(SCREEN_READER_ONLY)) element.remove();

  for (const element of root.querySelectorAll('[style]')) {
    // Anti-flicker snippets hide the whole page until scripts run.
    if (element.tagName === 'HTML' || element.tagName === 'BODY') continue;

    const style = styleDeclarations(element.getAttribute('style') ?? '');
    if (isHiddenByStyle(style)) element.remove();
    else if (ZERO_LENGTH.test(style.get('font-size') ?? '')) removeOwnText(element);
  }
}

function styleDeclarations(style: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const withoutComments = style.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const declaration of withoutComments.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).toLowerCase().replace(/\s+/g, '').replace('!important', '');
    declarations.set(property, value);
  }
  return declarations;
}

/** opacity: 0 is left alone: Webflow and Framer pages start animated content at opacity 0. */
function isHiddenByStyle(style: Map<string, string>): boolean {
  return isNotRendered(style) || isClipped(style) || isOffScreen(style) || isTransparentText(style);
}

function isNotRendered(style: Map<string, string>): boolean {
  const visibility = style.get('visibility');
  return style.get('display') === 'none' || visibility === 'hidden' || visibility === 'collapse';
}

/** The screen-reader-only pattern: clipped away, or squeezed to zero size. */
function isClipped(style: Map<string, string>): boolean {
  const clip = style.get('clip') ?? '';
  const clipPath = style.get('clip-path') ?? '';
  if (clip.startsWith('rect(') || clipPath.startsWith('inset(50%') || clipPath.startsWith('inset(100%')) return true;

  const zeroSize = ZERO_LENGTH.test(style.get('width') ?? '') || ZERO_LENGTH.test(style.get('height') ?? '');
  return zeroSize && style.get('overflow') === 'hidden';
}

/** Moved out of the viewport, such as `left: -9999px` or `text-indent: -999em`. */
function isOffScreen(style: Map<string, string>): boolean {
  return ['left', 'top', 'text-indent'].some((property) => FAR_NEGATIVE.test(style.get(property) ?? ''));
}

/** Gradient text is transparent too, but shows its background through the letters. */
function isTransparentText(style: Map<string, string>): boolean {
  const backgroundClip = style.get('background-clip') ?? style.get('-webkit-background-clip');
  return style.get('color') === 'transparent' && backgroundClip !== 'text';
}

/** Containers use font-size: 0 to collapse the whitespace between inline blocks, so their children stay. */
function removeOwnText(element: HTMLElement): void {
  for (const child of [...element.childNodes]) {
    if (child.nodeType === NodeType.TEXT_NODE) child.remove();
  }
}

function pageLinks(root: HTMLElement, pageUrl: URL): URL[] {
  const links: URL[] = [];
  for (const anchor of root.querySelectorAll('a[href]')) {
    const url = resolveLink(anchor.getAttribute('href') ?? '', pageUrl);
    if (url) links.push(url);
  }
  return links;
}

function resolveLink(href: string, pageUrl: URL): URL | undefined {
  let url: URL;
  try {
    url = new URL(href.trim(), pageUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  url.hash = '';
  return url;
}

/** Keeps the header or footer of an article, which is content. */
function removeSiteChrome(root: HTMLElement): void {
  for (const element of root.querySelectorAll(SITE_CHROME)) {
    if (!element.parentNode.closest(PAGE_CONTENT)) element.remove();
  }
}
