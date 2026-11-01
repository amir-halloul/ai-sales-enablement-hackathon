export const ZOOMINFO_CONFIG = Symbol('ZOOMINFO_CONFIG');
export const ZOOMINFO_FETCH = Symbol('ZOOMINFO_FETCH');

export type ZoomInfoCallType = 'token' | 'search' | 'enrich' | 'signals';

export interface ZoomInfoConfig {
  enabled: boolean;
  credentials: { clientId: string; clientSecret: string } | null;
  scopes: string[];
  baseUrl: string;
  userAgent: string;
  lookupBudgetMs: number;
  signalsBudgetMs: number;
  retries: Record<ZoomInfoCallType, number>;
  retryBaseDelayMs: number;
  defaultCooldownMs: number;
  tokenRefreshSkewMs: number;
  maxCandidates: number;
  keyPeopleLimit: number;
  newsLimit: number;
  newsLookbackDays: number;
  companyOutputFields: string[];
  contactOutputFields: string[];
}

export const DEFAULT_SCOPES = ['api:data:company', 'api:data:contact', 'api:data:news'];

export const DEFAULT_COMPANY_OUTPUT_FIELDS = [
  'id',
  'name',
  'website',
  'domainList',
  'description',
  'phone',
  'street',
  'city',
  'state',
  'zipCode',
  'country',
  'continent',
  'metroArea',
  'locationCount',
  'logo',
  'employeeCount',
  'employeeRange',
  'employeeGrowth',
  'employeeCountByDepartment',
  'revenue',
  'revenueRange',
  'departmentBudgets',
  'companyFunding',
  'recentFundingAmount',
  'recentFundingDate',
  'totalFundingAmount',
  'primaryIndustry',
  'primaryIndustryCode',
  'primarySubIndustryCode',
  'industries',
  'industryCodes',
  'sicCodes',
  'naicsCodes',
  'businessModel',
  'ticker',
  'type',
  'foundedYear',
  'products',
  'competitors',
  'subUnitType',
  'parentId',
  'parentName',
  'ultimateParentId',
  'ultimateParentName',
  'ultimateParentRevenue',
  'ultimateParentEmployees',
  'companyStatus',
  'companyStatusDate',
  'isDefunct',
  'certified',
  'socialMediaUrls',
  'lastUpdatedDate',
];

export const DEFAULT_CONTACT_OUTPUT_FIELDS = [
  'id',
  'firstName',
  'middleName',
  'lastName',
  'jobTitle',
  'jobFunction',
  'managementLevel',
  'positionStartDate',
  'email',
  'phone',
  'mobilePhone',
  'directPhoneDoNotCall',
  'mobilePhoneDoNotCall',
  'street',
  'city',
  'state',
  'zipCode',
  'country',
  'metroArea',
  'hasCanadianEmail',
  'withinCanada',
  'withinEu',
  'withinCalifornia',
  'externalUrls',
  'contactAccuracyScore',
  'employmentHistory',
  'lastUpdatedDate',
  'validDate',
  'personHasMoved',
  'isDefunct',
  'companyId',
  'companyName',
  'companyWebsite',
  'companyType',
  'companyTicker',
  'companyPhone',
  'companyStreet',
  'companyCity',
  'companyState',
  'companyZipCode',
  'companyCountry',
  'companyEmployeeCount',
  'companyEmployeeRange',
  'companyRevenueNumeric',
  'companyRevenueRange',
  'companyPrimaryIndustry',
  'companyIndustries',
];

type Env = Record<string, string | undefined>;

export function loadZoomInfoConfig(env: Env = process.env): ZoomInfoConfig {
  const clientId = env.ZOOMINFO_CLIENT_ID?.trim();
  const clientSecret = env.ZOOMINFO_CLIENT_SECRET?.trim();
  let baseUrl = env.ZOOMINFO_BASE_URL?.trim() || 'https://api.zoominfo.com/gtm';
  while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
  if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(baseUrl)) {
    throw new Error('ZOOMINFO_BASE_URL must be an https URL');
  }

  return {
    enabled: readBoolean(env, 'ZOOMINFO_ENABLED', true),
    credentials: clientId && clientSecret ? { clientId, clientSecret } : null,
    scopes: readScopes(env),
    baseUrl,
    userAgent: env.ZOOMINFO_USER_AGENT?.trim() || `taa-enrichment-api/${env.APP_VERSION?.trim() || 'local'}`,
    lookupBudgetMs: readInt(env, 'ZOOMINFO_LOOKUP_BUDGET_MS', 20_000, 1),
    signalsBudgetMs: readInt(env, 'ZOOMINFO_SIGNALS_BUDGET_MS', 20_000, 1),
    retries: {
      token: readInt(env, 'ZOOMINFO_RETRIES_TOKEN', 1, 0),
      search: readInt(env, 'ZOOMINFO_RETRIES_SEARCH', 1, 0),
      enrich: readInt(env, 'ZOOMINFO_RETRIES_ENRICH', 1, 0),
      signals: readInt(env, 'ZOOMINFO_RETRIES_SIGNALS', 1, 0),
    },
    retryBaseDelayMs: 500,
    defaultCooldownMs: 1_000,
    tokenRefreshSkewMs: 60_000,
    maxCandidates: 10,
    keyPeopleLimit: 10,
    newsLimit: 10,
    newsLookbackDays: 365,
    companyOutputFields: readFields(env, 'ZOOMINFO_COMPANY_FIELDS', DEFAULT_COMPANY_OUTPUT_FIELDS),
    contactOutputFields: readFields(env, 'ZOOMINFO_CONTACT_FIELDS', DEFAULT_CONTACT_OUTPUT_FIELDS),
  };
}

function readBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function readInt(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

function readScopes(env: Env): string[] {
  const raw = env.ZOOMINFO_SCOPES?.trim();
  if (!raw) return DEFAULT_SCOPES;
  const scopes = raw.split(/[\s,]+/).filter(Boolean);
  if (scopes.some((s) => !/^api:[a-z-]+(:[a-z-]+)*$/.test(s))) {
    throw new Error('ZOOMINFO_SCOPES must be a space- or comma-separated list of ZoomInfo scopes');
  }
  return scopes;
}

function readFields(env: Env, name: string, fallback: string[]): string[] {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const fields = raw.split(',').map((f) => f.trim()).filter(Boolean);
  if (fields.length === 0 || fields.some((f) => !/^[A-Za-z]+$/.test(f))) {
    throw new Error(`${name} must be a comma-separated list of field names`);
  }
  return fields;
}
