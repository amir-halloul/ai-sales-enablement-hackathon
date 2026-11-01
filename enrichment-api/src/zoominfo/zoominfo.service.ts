import { Inject, Injectable, Logger } from '@nestjs/common';
import { sameRegistrableDomain } from '../common/registrable-domain.js';
import { ZoomInfoClient } from './zoominfo.client.js';
import { ZOOMINFO_CONFIG, type ZoomInfoConfig } from './zoominfo.config.js';
import { ZoomInfoError } from './zoominfo.errors.js';
import {
  matchMeta,
  parseResourceList,
  toCompanyCandidate,
  toCompanyProfile,
  toNewsArticle,
  toPersonCandidate,
  toPersonProfile,
  toTechnology,
} from './zoominfo.parsers.js';
import { createBudget } from './zoominfo.transport.js';
import type {
  CompanyCandidate,
  CompanyEnrichInput,
  CompanyEnrichOptions,
  CompanyEnrichResult,
  CompanyIdentifyInput,
  CompanyIdentifyResult,
  CompanyProfile,
  EvidenceSection,
  IdentifyResult,
  KeyPerson,
  MatchBasis,
  NewsArticle,
  PersonCandidate,
  PersonEnrichInput,
  PersonEnrichResult,
  PersonIdentifyInput,
  PersonIdentifyResult,
  Technology,
  ZoomInfoBudget,
  ZoomInfoCallOptions,
  ZoomInfoWarning,
} from './zoominfo.types.js';

type Selection<T> = { match: T; basis: MatchBasis } | null;

interface ProfileLookup {
  matchStatus: string;
  warningCodes: string[];
  profile: CompanyProfile | null;
}

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc',
  'nv', 'bv', 'gmbh', 'ag', 'sa', 'sas', 'srl', 'spa', 'oy', 'ab', 'as', 'pty', 'lp', 'llp',
]);

/**
 * ZoomInfo provider adapter. Identify uses the free Search endpoints and returns candidates;
 * Enrich requires a resolved ZoomInfo ID and consumes credits for records not yet under management.
 */
@Injectable()
export class ZoomInfoService {
  private readonly logger = new Logger('ZoomInfo');

  constructor(
    @Inject(ZOOMINFO_CONFIG) private readonly config: ZoomInfoConfig,
    @Inject(ZoomInfoClient) private readonly client: ZoomInfoClient,
  ) {
    if (!config.enabled) this.logger.warn('ZoomInfo provider disabled (ZOOMINFO_ENABLED=false)');
    else if (!config.credentials) this.logger.warn('ZoomInfo credentials not configured; provider unavailable');
  }

  isAvailable(): boolean {
    return this.config.enabled && this.config.credentials !== null;
  }

  async identifyCompany(input: CompanyIdentifyInput, options: ZoomInfoCallOptions = {}): Promise<CompanyIdentifyResult> {
    const operation = 'companies.search';
    this.ensureAvailable(operation);
    const zoomInfoId = parseId(input.zoomInfoId, operation);
    const name = clean(input.name);
    const domain = normalizeDomain(input.website);
    if (!zoomInfoId && !name && !domain) throw new ZoomInfoError('invalid_request', { operation });

    // Strongest identifier only: ID > website > name. The others are used for disambiguation.
    let attributes: Record<string, string | undefined> = { companyName: name, country: clean(input.country) };
    if (zoomInfoId) attributes = { companyId: zoomInfoId };
    else if (domain) attributes = { companyWebsite: `http://www.${domain}` };
    const body = await this.client.post(
      {
        operation,
        callType: 'search',
        path: '/data/v1/companies/search',
        type: 'CompanySearch',
        attributes,
        query: { 'page[size]': this.config.maxCandidates },
      },
      createBudget(this.config.lookupBudgetMs, options),
    );
    const list = parseResourceList(body, ['Company'], operation);
    const candidates = list.items.map(toCompanyCandidate);
    const selection = selectCompany(candidates, zoomInfoId, domain, name);
    return { ...identifyResult(candidates, list.totalResults, selection), entityType: 'company' };
  }

  async identifyPerson(input: PersonIdentifyInput, options: ZoomInfoCallOptions = {}): Promise<PersonIdentifyResult> {
    const operation = 'contacts.search';
    this.ensureAvailable(operation);
    const zoomInfoId = parseId(input.zoomInfoId, operation);
    const firstName = clean(input.firstName);
    const lastName = clean(input.lastName);
    const fullName = clean(input.fullName) ?? clean([firstName, lastName].filter(Boolean).join(' '));
    const email = clean(input.email);
    const companyId = parseId(input.companyZoomInfoId, operation);
    const companyDomain = normalizeDomain(input.companyWebsite);
    const companyName = clean(input.companyName);
    if (!zoomInfoId && !email && !fullName) throw new ZoomInfoError('invalid_request', { operation });

    const attributes: Record<string, unknown> = {};
    if (zoomInfoId) {
      attributes.personId = zoomInfoId;
    } else {
      if (email) attributes.emailAddress = email;
      if (firstName && lastName && !input.fullName) Object.assign(attributes, { firstName, lastName });
      else if (fullName) attributes.fullName = fullName;
      const jobTitle = clean(input.jobTitle);
      if (jobTitle) attributes.jobTitle = jobTitle;
      if (companyId) attributes.companyId = companyId;
      else if (companyDomain) attributes.companyWebsite = `http://www.${companyDomain}`;
      else if (companyName) attributes.companyName = companyName;
    }

    const body = await this.client.post(
      {
        operation,
        callType: 'search',
        path: '/data/v1/contacts/search',
        type: 'ContactSearch',
        attributes,
        query: { 'page[size]': this.config.maxCandidates },
      },
      createBudget(this.config.lookupBudgetMs, options),
    );
    const list = parseResourceList(body, ['Contact'], operation);
    const candidates = list.items.map(toPersonCandidate);
    const selection = selectPerson(candidates, zoomInfoId, fullName, companyId, companyName);
    return { ...identifyResult(candidates, list.totalResults, selection), entityType: 'person' };
  }

  async enrichCompany(input: CompanyEnrichInput, options: CompanyEnrichOptions = {}): Promise<CompanyEnrichResult> {
    const operation = 'companies.enrich';
    this.ensureAvailable(operation);
    const zoomInfoId = requireId(input.zoomInfoId, operation);
    const include = { technologies: true, keyPeople: true, news: true, ...options.include };

    // Supplementary evidence runs in parallel on its own budget and is cancelled if the profile fails.
    const branch = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, branch.signal]) : branch.signal;
    const signals = createBudget(this.config.signalsBudgetMs, { ...options, signal });
    const sectionsPromise = Promise.all([
      section(include.technologies, () => this.fetchTechnologies(zoomInfoId, signals)),
      section(include.keyPeople, () => this.fetchKeyPeople(zoomInfoId, signals)),
      section(include.news, () => this.fetchNews(zoomInfoId, signals)),
    ]);

    let profileResult: ProfileLookup;
    try {
      profileResult = await this.fetchCompanyProfile(zoomInfoId, createBudget(this.config.lookupBudgetMs, options));
    } catch (error) {
      branch.abort();
      await sectionsPromise;
      throw error;
    }
    if (!profileResult.profile) branch.abort();
    const [technologies, keyPeople, news] = profileResult.profile
      ? await sectionsPromise
      : await sectionsPromise.then(() => [skipped<Technology>(), skipped<KeyPerson>(), skipped<NewsArticle>()] as const);

    const warnings: ZoomInfoWarning[] = profileResult.warningCodes.map((upstreamCode) => ({
      section: 'profile',
      code: 'upstream_warning',
      upstreamCode,
    }));
    for (const [name, s] of [['technologies', technologies], ['keyPeople', keyPeople], ['news', news]] as const) {
      if (s.status === 'failed' && s.error) warnings.push({ section: name, code: s.error });
    }

    return {
      provider: 'zoominfo',
      entityType: 'company',
      retrievedAt: new Date().toISOString(),
      source: { sourceType: 'zoominfo', sourceReference: profileResult.profile ? zoomInfoId : null },
      status: profileResult.profile ? 'matched' : 'no_match',
      matchStatus: profileResult.matchStatus,
      completeness: [technologies, keyPeople, news].some((s) => s.status === 'failed') ? 'partial' : 'complete',
      warnings,
      profile: profileResult.profile,
      technologies,
      keyPeople,
      news,
    };
  }

  async enrichPerson(input: PersonEnrichInput, options: ZoomInfoCallOptions = {}): Promise<PersonEnrichResult> {
    const operation = 'contacts.enrich';
    this.ensureAvailable(operation);
    const zoomInfoId = requireId(input.zoomInfoId, operation);
    const body = await this.client.post(
      {
        operation,
        callType: 'enrich',
        path: '/data/v1/contacts/enrich',
        type: 'ContactEnrich',
        attributes: {
          matchPersonInput: [{ personId: Number(zoomInfoId) }],
          outputFields: this.config.contactOutputFields,
        },
      },
      createBudget(this.config.lookupBudgetMs, options),
    );
    const [first] = parseResourceList(body, ['Contact', 'NoMatch'], operation).items;
    const { matchStatus, warningCodes } = first ? matchMeta(first) : { matchStatus: 'NO_MATCH', warningCodes: [] };
    assertMatchStatus(matchStatus, operation);
    const profile = first?.type === 'Contact' && matchStatus !== 'COMPANY_ONLY_MATCH' ? toPersonProfile(first) : null;

    return {
      provider: 'zoominfo',
      entityType: 'person',
      retrievedAt: new Date().toISOString(),
      source: { sourceType: 'zoominfo', sourceReference: profile ? profile.zoomInfoId : null },
      status: profile ? 'matched' : 'no_match',
      matchStatus,
      warnings: warningCodes.map((upstreamCode) => ({ section: 'profile', code: 'upstream_warning', upstreamCode })),
      profile,
    };
  }

  private async fetchCompanyProfile(zoomInfoId: string, budget: ZoomInfoBudget): Promise<ProfileLookup> {
    const operation = 'companies.enrich';
    const body = await this.client.post(
      {
        operation,
        callType: 'enrich',
        path: '/data/v1/companies/enrich',
        type: 'CompanyEnrich',
        attributes: {
          matchCompanyInput: [{ companyId: Number(zoomInfoId) }],
          outputFields: this.config.companyOutputFields,
        },
      },
      budget,
    );
    const [first] = parseResourceList(body, ['Company', 'NoMatch'], operation).items;
    const { matchStatus, warningCodes } = first ? matchMeta(first) : { matchStatus: 'NO_MATCH', warningCodes: [] };
    assertMatchStatus(matchStatus, operation);
    return { matchStatus, warningCodes, profile: first?.type === 'Company' ? toCompanyProfile(first) : null };
  }

  private async fetchTechnologies(zoomInfoId: string, budget: ZoomInfoBudget): Promise<Technology[]> {
    const operation = 'technologies.enrich';
    const body = await this.client.post(
      {
        operation,
        callType: 'signals',
        path: '/data/v1/companies/technologies/enrich',
        type: 'TechnologyEnrich',
        attributes: { companyId: Number(zoomInfoId) },
      },
      budget,
    );
    return parseResourceList(body, ['Technology'], operation).items.map(toTechnology);
  }

  /** Executives via the free Search Contacts endpoint (Org Chart requires department IDs and credits). */
  private async fetchKeyPeople(zoomInfoId: string, budget: ZoomInfoBudget): Promise<KeyPerson[]> {
    const operation = 'contacts.search.executives';
    const body = await this.client.post(
      {
        operation,
        callType: 'signals',
        path: '/data/v1/contacts/search',
        type: 'ContactSearch',
        attributes: { companyId: zoomInfoId, executivesOnly: true },
        query: { 'page[size]': this.config.keyPeopleLimit },
      },
      budget,
    );
    return parseResourceList(body, ['Contact'], operation).items.map((resource) => {
      const c = toPersonCandidate(resource);
      return {
        zoomInfoId: c.zoomInfoId,
        name: [c.firstName, c.middleName, c.lastName].filter(Boolean).join(' '),
        jobTitle: c.jobTitle,
        managementLevel: c.managementLevel,
        contactAccuracyScore: c.contactAccuracyScore,
      };
    });
  }

  private async fetchNews(zoomInfoId: string, budget: ZoomInfoBudget): Promise<NewsArticle[]> {
    const operation = 'news.enrich';
    const since = new Date(Date.now() - this.config.newsLookbackDays * 86_400_000).toISOString().slice(0, 10);
    const body = await this.client.post(
      {
        operation,
        callType: 'signals',
        path: '/data/v1/news/enrich',
        type: 'NewsEnrich',
        attributes: { companyId: Number(zoomInfoId), pageDateMin: since },
        query: { 'page[size]': this.config.newsLimit },
      },
      budget,
    );
    return parseResourceList(body, ['News'], operation)
      .items.map(toNewsArticle)
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  }

  private ensureAvailable(operation: string): void {
    if (!this.config.enabled) throw new ZoomInfoError('disabled', { operation });
    if (!this.config.credentials) throw new ZoomInfoError('not_configured', { operation });
  }
}

async function section<T>(enabled: boolean, fetchItems: () => Promise<T[]>): Promise<EvidenceSection<T>> {
  if (!enabled) return skipped<T>();
  try {
    const items = await fetchItems();
    return { status: 'ok', retrievedAt: new Date().toISOString(), error: null, items };
  } catch (error) {
    if (!(error instanceof ZoomInfoError)) throw error;
    return { status: 'failed', retrievedAt: null, error: error.code, items: [] };
  }
}

function skipped<T>(): EvidenceSection<T> {
  return { status: 'skipped', retrievedAt: null, error: null, items: [] };
}

function identifyResult<T extends { zoomInfoId: string }>(
  candidates: T[],
  totalResults: number,
  selection: Selection<T>,
): Omit<IdentifyResult<T>, 'entityType'> {
  let status: IdentifyResult<T>['status'] = 'ambiguous';
  if (selection) status = 'matched';
  else if (candidates.length === 0) status = 'no_match';
  return {
    provider: 'zoominfo',
    retrievedAt: new Date().toISOString(),
    status,
    matchBasis: selection?.basis ?? null,
    match: selection?.match ?? null,
    candidates,
    totalResults,
    source: { sourceType: 'zoominfo', sourceReference: selection?.match.zoomInfoId ?? null },
  };
}

function selectCompany(
  candidates: CompanyCandidate[],
  zoomInfoId: string | undefined,
  domain: string | undefined,
  name: string | undefined,
): Selection<CompanyCandidate> {
  if (zoomInfoId) return single(candidates.filter((c) => c.zoomInfoId === zoomInfoId), 'zoominfo_id');
  if (candidates.length === 1) return { match: candidates[0], basis: 'single_candidate' };

  let pool = candidates;
  if (domain) {
    pool = candidates.filter((c) => sameRegistrableDomain(c.website, domain));
    if (pool.length === 1) return { match: pool[0], basis: 'exact_domain' };
    if (pool.length === 0) pool = candidates;
  }
  if (!name) return null;
  const target = normalizeCompanyName(name);
  return single(pool.filter((c) => c.name !== undefined && normalizeCompanyName(c.name) === target), 'exact_name');
}

function selectPerson(
  candidates: PersonCandidate[],
  zoomInfoId: string | undefined,
  fullName: string | undefined,
  companyId: string | undefined,
  companyName: string | undefined,
): Selection<PersonCandidate> {
  if (zoomInfoId) return single(candidates.filter((c) => c.zoomInfoId === zoomInfoId), 'zoominfo_id');
  if (candidates.length === 1) return { match: candidates[0], basis: 'single_candidate' };
  if (!fullName) return null;

  const target = normalizeText(fullName);
  const company = companyName ? normalizeCompanyName(companyName) : undefined;
  return single(
    candidates.filter(
      (c) =>
        normalizeText([c.firstName, c.lastName].filter(Boolean).join(' ')) === target &&
        (!companyId || c.company?.zoomInfoId === companyId) &&
        (!company || (c.company?.name !== undefined && normalizeCompanyName(c.company.name) === company)),
    ),
    'exact_name',
  );
}

function single<T>(matches: T[], basis: MatchBasis): Selection<T> {
  return matches.length === 1 ? { match: matches[0], basis } : null;
}

function assertMatchStatus(matchStatus: string, operation: string): void {
  if (matchStatus === 'LIMIT_EXCEEDED') throw new ZoomInfoError('quota_exceeded', { operation });
  if (matchStatus === 'INVALID_INPUT') throw new ZoomInfoError('invalid_request', { operation });
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, 500) : undefined;
}

function parseId(value: string | undefined, operation: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^\d{1,15}$/.test(trimmed)) throw new ZoomInfoError('invalid_request', { operation });
  return trimmed;
}

function requireId(value: string | undefined, operation: string): string {
  const parsed = parseId(value, operation);
  if (!parsed) throw new ZoomInfoError('invalid_request', { operation });
  return parsed;
}

export function normalizeDomain(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll('.', '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeCompanyName(value: string): string {
  const tokens = normalizeText(value).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens.at(-1) ?? '')) tokens.pop();
  return tokens.join(' ');
}
