// Official profiles are the ones the company links to from its own website, usually in the footer.

type ProfilePath = (segments: string[]) => string[] | undefined;

interface Network {
  domain: string;
  /** All links to the network are rewritten to this host, so twitter.com and x.com links are the same profile. */
  host: string;
  profilePath: ProfilePath;
}

/** First path segments that are features of the network, not account names. */
const NOT_ACCOUNTS = new Set([
  'about', 'dialog', 'embed', 'explore', 'hashtag', 'help', 'home', 'i', 'intent', 'legal', 'login', 'p', 'pages',
  'plugins', 'policies', 'privacy', 'reel', 'search', 'share', 'sharer', 'sharer.php', 'shareArticle', 'watch',
]);

const account: ProfilePath = (segments) => {
  if (segments.length !== 1 || NOT_ACCOUNTS.has(segments[0])) return undefined;
  return segments;
};

/** linkedin.com/company/acme/about is the profile linkedin.com/company/acme. */
const linkedInPage: ProfilePath = (segments) => {
  if (segments.length < 2 || !['company', 'school', 'showcase'].includes(segments[0])) return undefined;
  return segments.slice(0, 2);
};

const youTubeChannel: ProfilePath = (segments) => {
  if (segments.length === 1 && segments[0].startsWith('@')) return segments;
  if (segments.length === 2 && ['c', 'channel', 'user'].includes(segments[0])) return segments;
  return undefined;
};

const tikTokAccount: ProfilePath = (segments) => {
  return segments.length === 1 && segments[0].startsWith('@') ? segments : undefined;
};

const NETWORKS: Network[] = [
  { domain: 'linkedin.com', host: 'www.linkedin.com', profilePath: linkedInPage },
  { domain: 'x.com', host: 'x.com', profilePath: account },
  { domain: 'twitter.com', host: 'x.com', profilePath: account },
  { domain: 'facebook.com', host: 'www.facebook.com', profilePath: account },
  { domain: 'instagram.com', host: 'www.instagram.com', profilePath: account },
  { domain: 'youtube.com', host: 'www.youtube.com', profilePath: youTubeChannel },
  { domain: 'github.com', host: 'github.com', profilePath: account },
  { domain: 'tiktok.com', host: 'www.tiktok.com', profilePath: tikTokAccount },
];

/** The canonical profile URL when the link points to an account on a known network; share links and posts are not. */
export function socialProfileUrl(link: URL): string | undefined {
  const network = NETWORKS.find((n) => link.hostname === n.domain || link.hostname.endsWith(`.${n.domain}`));
  if (!network) return undefined;
  const segments = link.pathname.split('/').filter(Boolean);
  const path = network.profilePath(segments);
  return path ? `https://${network.host}/${path.join('/')}` : undefined;
}
