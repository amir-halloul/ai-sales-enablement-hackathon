import { ZoomInfoError } from './zoominfo.errors.js';
import type {
  CodeName,
  CompanyCandidate,
  CompanyProfile,
  CompanyRef,
  NewsArticle,
  PersonCandidate,
  PersonCompany,
  PersonProfile,
  Technology,
} from './zoominfo.types.js';

type Json = Record<string, unknown>;

const MAX_COMPETITORS = 10;

export interface Resource {
  id: string;
  type: string;
  attributes: Json;
  meta: Json;
}

export interface ResourceList {
  items: Resource[];
  totalResults: number;
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : str(value);

const num = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const s = str(value);
  return s !== undefined && Number.isFinite(Number(s)) ? Number(s) : undefined;
};

const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

const id = (value: unknown): string | undefined => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  return typeof value === 'string' && /^\d{1,19}$/.test(value.trim()) ? value.trim() : undefined;
};

const resourceId = (value: unknown): string | undefined =>
  id(value) ?? (typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value) ? value : undefined);

// ZoomInfo uses 0 for "no company" (no parent, unknown employer).
const companyId = (value: unknown): string | undefined => {
  const result = id(value);
  return result === '0' ? undefined : result;
};

const lower = (value: unknown): string | undefined => str(value)?.toLowerCase();

const strList = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : [value];
  return list.map(str).filter((v): v is string => v !== undefined);
};

const objects = (value: unknown): Json[] => (Array.isArray(value) ? value : [value]).filter(isObject);

const numberRecord = (value: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries(isObject(value) ? value : {})
      .map(([key, v]) => [key, num(v)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
  );

const codeNames = (value: unknown): CodeName[] =>
  objects(value)
    .map((o) => ({ id: text(o.id), name: str(o.name) }))
    .filter((c) => c.id !== undefined || c.name !== undefined);

const urls = (value: unknown): { type?: string; url: string }[] =>
  objects(value).flatMap((o) => {
    const url = str(o.url);
    return url ? [{ type: str(o.type), url }] : [];
  });

const ref = (zoomInfoId: unknown, name: unknown): CompanyRef | null => {
  const r = { zoomInfoId: companyId(zoomInfoId), name: str(name) };
  return r.zoomInfoId || r.name ? r : null;
};

/** Validates a JSON:API list envelope; anything structurally unexpected is a contract error. */
export function parseResourceList(body: unknown, types: string[], operation: string): ResourceList {
  const malformed = (): ZoomInfoError => new ZoomInfoError('malformed_response', { operation });
  if (!isObject(body) || !Array.isArray(body.data)) throw malformed();

  const items = body.data.map((item): Resource => {
    if (!isObject(item) || typeof item.type !== 'string' || !types.includes(item.type)) throw malformed();
    const itemId = resourceId(item.id);
    if (item.type !== 'NoMatch' && (itemId === undefined || !isObject(item.attributes))) throw malformed();
    return {
      id: itemId ?? '0',
      type: item.type,
      attributes: isObject(item.attributes) ? item.attributes : {},
      meta: isObject(item.meta) ? item.meta : {},
    };
  });
  const totalResults = isObject(body.meta) ? num(body.meta.totalResults) : undefined;
  return { items, totalResults: totalResults ?? items.length };
}

export function matchMeta(resource: Resource): { matchStatus: string; warningCodes: string[] } {
  return {
    matchStatus: str(resource.meta.matchStatus) ?? 'UNKNOWN',
    warningCodes: objects(resource.meta.warnings)
      .map((w) => str(w.code))
      .filter((c): c is string => c !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(c)),
  };
}

export function toCompanyCandidate({ id: zoomInfoId, attributes: a }: Resource): CompanyCandidate {
  return {
    zoomInfoId,
    name: str(a.name),
    website: str(a.website),
    city: str(a.city),
    state: str(a.state),
    country: str(a.country),
    employeeCount: text(a.employeeCount),
    revenue: text(a.revenue),
  };
}

export function toPersonCandidate({ id: zoomInfoId, attributes: a }: Resource): PersonCandidate {
  const company = isObject(a.company) ? ref(a.company.id, a.company.name) : null;
  return {
    zoomInfoId,
    firstName: str(a.firstName),
    middleName: str(a.middleName),
    lastName: str(a.lastName),
    jobTitle: str(a.jobTitle),
    managementLevel: strList(a.managementLevel),
    contactAccuracyScore: num(a.contactAccuracyScore),
    lastUpdatedDate: str(a.lastUpdatedDate),
    company,
  };
}

export function toCompanyProfile({ id: zoomInfoId, attributes: a }: Resource): CompanyProfile {
  const growth = isObject(a.employeeGrowth) ? a.employeeGrowth : null;
  const ultimateParent = ref(a.ultimateParentId, a.ultimateParentName);
  return {
    zoomInfoId,
    name: str(a.name),
    website: str(a.website),
    domains: strList(a.domainList),
    description: str(a.description),
    logoUrl: str(a.logo),
    phone: str(a.phone),
    address: {
      street: str(a.street),
      city: str(a.city),
      state: str(a.state),
      zipCode: str(a.zipCode),
      country: str(a.country),
      continent: str(a.continent),
      metroArea: str(a.metroArea),
    },
    locationCount: num(a.locationCount),
    headcount: num(a.employeeCount),
    employeeRange: str(a.employeeRange),
    employeeGrowth: growth && {
      oneYearRate: text(growth.oneYearGrowthRate),
      twoYearRate: text(growth.twoYearGrowthRate),
      quarterly: objects(growth.employeeGrowthDataPoints).map((p) => ({
        label: str(p.label),
        headcount: num(p.employeeCount),
      })),
    },
    headcountByDepartment: numberRecord(a.employeeCountByDepartment),
    revenueThousandsUsd: num(a.revenue),
    revenueRange: str(a.revenueRange),
    departmentBudgets: numberRecord(a.departmentBudgets),
    funding: {
      totalThousandsUsd: num(a.totalFundingAmount),
      mostRecentThousandsUsd: num(a.recentFundingAmount),
      mostRecentDate: str(a.recentFundingDate),
      rounds: objects(a.companyFunding)
        .map((f) => ({
          date: str(f.date),
          type: str(f.type),
          amountThousandsUsd: num(f.amount),
          investors: strList(f.investors),
        }))
        .sort((x, y) => (y.date ?? '').localeCompare(x.date ?? '')),
    },
    ownershipType: lower(a.type),
    ticker: str(a.ticker),
    foundedYear: text(a.foundedYear),
    businessModel: strList(a.businessModel),
    primaryIndustry: strList(a.primaryIndustry),
    primaryIndustryCodes: codeNames(a.primaryIndustryCode),
    primarySubIndustryCodes: codeNames(a.primarySubIndustryCode),
    industries: strList(a.industries),
    industryCodes: codeNames(a.industryCodes),
    sicCodes: codeNames(a.sicCodes),
    naicsCodes: codeNames(a.naicsCodes),
    productsAndServices: strList(a.products),
    competitors: objects(a.competitors)
      .map((c) => ({
        zoomInfoId: companyId(c.id),
        name: str(c.name),
        website: str(c.website),
        rank: num(c.rank),
        headcount: num(c.employeeCount),
      }))
      .filter((c) => c.name !== undefined)
      .sort((x, y) => (x.rank ?? Infinity) - (y.rank ?? Infinity))
      .slice(0, MAX_COMPETITORS),
    subUnitType: str(a.subUnitType),
    parent: ref(a.parentId, a.parentName),
    ultimateParent: ultimateParent && {
      ...ultimateParent,
      revenueThousandsUsd: num(a.ultimateParentRevenue),
      headcount: num(a.ultimateParentEmployees),
    },
    companyStatus: str(a.companyStatus),
    companyStatusDate: str(a.companyStatusDate),
    isDefunct: bool(a.isDefunct),
    certified: bool(a.certified),
    socialMediaUrls: objects(a.socialMediaUrls).flatMap((o) => {
      const url = str(o.url);
      return url ? [{ type: str(o.type), url, followerCount: num(o.followerCount) }] : [];
    }),
    lastUpdatedDate: str(a.lastUpdatedDate),
  };
}

function toPersonCompany(c: Json): PersonCompany {
  return {
    zoomInfoId: companyId(c.id),
    name: str(c.name),
    website: str(c.website),
    ownershipType: lower(c.type),
    ticker: str(c.ticker),
    phone: str(c.phone),
    address: { street: str(c.street), city: str(c.city), state: str(c.state), zipCode: str(c.zipCode), country: str(c.country) },
    headcount: num(c.employeeCount),
    employeeRange: str(c.employeeRange),
    revenueUsd: num(c.revenueNumeric),
    revenueRange: str(c.revenueRange),
    primaryIndustry: strList(c.primaryIndustry),
    industries: strList(c.industries),
  };
}

export function toPersonProfile({ id: zoomInfoId, attributes: a }: Resource): PersonProfile {
  const jobFunctions = objects(a.jobFunction)
    .map((f) => ({ name: str(f.name), department: str(f.department) }))
    .filter((f) => f.name || f.department);
  return {
    zoomInfoId,
    firstName: str(a.firstName),
    middleName: str(a.middleName),
    lastName: str(a.lastName),
    jobTitle: str(a.jobTitle),
    jobFunctions,
    managementLevel: strList(a.managementLevel),
    positionStartDate: str(a.positionStartDate),
    email: str(a.email),
    phone: str(a.phone),
    mobilePhone: str(a.mobilePhone),
    doNotCall: { phone: bool(a.directPhoneDoNotCall), mobilePhone: bool(a.mobilePhoneDoNotCall) },
    location: {
      street: str(a.street),
      city: str(a.city),
      state: str(a.state),
      zipCode: str(a.zipCode),
      country: str(a.country),
      metroArea: str(a.metroArea),
    },
    jurisdiction: {
      withinCanada: bool(a.withinCanada),
      hasCanadianEmail: bool(a.hasCanadianEmail),
      withinEu: bool(a.withinEu),
      withinCalifornia: bool(a.withinCalifornia),
    },
    externalUrls: urls(a.externalUrls),
    contactAccuracyScore: num(a.contactAccuracyScore),
    employmentHistory: objects(a.employmentHistory).map((h) => ({
      jobTitle: str(h.jobTitle),
      fromDate: str(h.fromDate),
      toDate: str(h.toDate),
      company: isObject(h.company)
        ? {
            zoomInfoId: companyId(h.company.companyId),
            name: str(h.company.companyName),
            website: str(h.company.companyWebsite),
          }
        : null,
    })),
    personHasMoved: str(a.personHasMoved),
    isDefunct: bool(a.isDefunct),
    lastUpdatedDate: str(a.lastUpdatedDate),
    validDate: str(a.validDate),
    company: isObject(a.company) ? toPersonCompany(a.company) : null,
  };
}

export function toTechnology({ id: zoomInfoId, attributes: a }: Resource): Technology {
  return {
    zoomInfoId,
    product: str(a.product),
    vendor: str(a.vendor),
    category: str(a.category),
    categoryParent: str(a.categoryParent),
  };
}

export function toNewsArticle({ id: zoomInfoId, attributes: a }: Resource): NewsArticle {
  return {
    zoomInfoId,
    title: str(a.title),
    url: str(a.url),
    domain: str(a.domain),
    publishedAt: str(a.pageDate),
    summary: str(a.description),
    categories: strList(a.categories),
  };
}
