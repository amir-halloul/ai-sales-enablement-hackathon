import {
  addFact,
  address,
  ADDRESS,
  citedList,
  citedValue,
  httpUrl,
  NEWS_ITEM,
  newsItem,
  NULLABLE_INTEGER,
  NULLABLE_NUMBER,
  NULLABLE_STRING,
  object,
  positiveInteger,
  positiveNumber,
  record,
  records,
  STRING,
  text,
  year,
  type CitedObservations,
  type Json,
  type JsonSchema,
} from './model-answer.js';

// Each topic is one web search prompt (prompts/web-search/<name>.hbs) with the JSON schema of its answer.
// Every value in an answer carries the URL it came from ("source") and the model's confidence.

export interface Topic {
  /** Template name and log label. */
  name: string;
  /** Response attribute named in the warning when this topic fails; null when it feeds several attributes. */
  attribute: string | null;
  schema: JsonSchema;
  read(output: unknown, found: CitedObservations): void;
}

const OWNERSHIP_TYPES = ['public', 'private', 'npo', 'education', 'government', 'other'];

const COMPANY_FACTS: Topic = {
  name: 'company-facts',
  attribute: null,
  schema: object({
    website: citedValue(NULLABLE_STRING),
    headquarters: citedValue(ADDRESS),
    phone: citedValue(NULLABLE_STRING),
    headcount: citedValue(NULLABLE_INTEGER),
    annualRevenueUsd: citedValue(NULLABLE_NUMBER),
    ownershipType: citedValue({ type: ['string', 'null'], enum: [...OWNERSHIP_TYPES, null] }),
    tickerSymbol: citedValue(NULLABLE_STRING),
    foundedYear: citedValue(NULLABLE_INTEGER),
  }),
  read(output, found) {
    const facts = record(output);
    addFact(found, facts, 'website', 'website', text);
    addFact(found, facts, 'address', 'headquarters', address);
    addFact(found, facts, 'phone', 'phone', text);
    addFact(found, facts, 'headcount', 'headcount', positiveInteger);
    addFact(found, facts, 'annualRevenueUsd', 'annualRevenueUsd', positiveNumber);
    addFact(found, facts, 'ownershipType', 'ownershipType', text);
    addFact(found, facts, 'tickerSymbol', 'tickerSymbol', text);
    addFact(found, facts, 'foundedYear', 'foundedYear', year);
  },
};

const KEY_PEOPLE: Topic = {
  name: 'key-people',
  attribute: 'keyPeople',
  schema: object({ people: citedList({ name: STRING, jobTitle: STRING }) }),
  read(output, found) {
    for (const person of records(record(output).people)) {
      const name = text(person.name);
      const jobTitle = text(person.jobTitle);
      if (name && jobTitle) found.add('keyPeople', { name, jobTitle }, person);
    }
  },
};

const NEWS: Topic = {
  name: 'news',
  attribute: 'newsHeadlines',
  schema: object({ articles: citedList(NEWS_ITEM) }),
  read(output, found) {
    for (const article of records(record(output).articles)) found.add('newsHeadlines', newsItem(article), article);
  },
};

const FINANCIALS_AND_GROWTH: Topic = {
  name: 'financials-and-growth',
  attribute: 'growthSignals',
  schema: object({ signals: citedList({ summary: STRING }) }),
  read(output, found) {
    for (const signal of records(record(output).signals)) found.add('growthSignals', text(signal.summary), signal);
  },
};

const SOCIAL_PROFILES: Topic = {
  name: 'social-profiles',
  attribute: 'socialProfiles',
  schema: object({ profiles: citedList({ url: STRING }) }),
  read(output, found) {
    for (const profile of records(record(output).profiles)) found.add('socialProfiles', httpUrl(profile.url), profile);
  },
};

const PRODUCTS_AND_MARKET: Topic = {
  name: 'products-and-market',
  attribute: 'productsAndServices',
  schema: object({ productsAndServices: citedList({ name: STRING }), competitors: citedList({ name: STRING }) }),
  read(output, found) {
    const answer = record(output);
    for (const product of records(answer.productsAndServices)) found.add('productsAndServices', text(product.name), product);
    for (const competitor of records(answer.competitors)) found.add('competitors', text(competitor.name), competitor);
  },
};

/** All run in parallel. */
export const COMPANY_TOPICS: readonly Topic[] = [
  COMPANY_FACTS,
  KEY_PEOPLE,
  NEWS,
  FINANCIALS_AND_GROWTH,
  SOCIAL_PROFILES,
  PRODUCTS_AND_MARKET,
];

const PERSON_PROFILE: Topic = {
  name: 'person-profile',
  attribute: null,
  schema: object({
    jobTitle: citedValue(NULLABLE_STRING),
    employer: citedValue(NULLABLE_STRING),
    location: citedValue(object({ city: NULLABLE_STRING, state: NULLABLE_STRING, country: NULLABLE_STRING })),
    summary: citedValue(NULLABLE_STRING),
  }),
  read(output, found) {
    const facts = record(output);
    addFact(found, facts, 'jobTitle', 'jobTitle', text);
    addFact(found, facts, 'companyName', 'employer', text);
    addFact(found, facts, 'address', 'location', address);
    addFact(found, facts, 'description', 'summary', text);
  },
};

const PERSON_CAREER: Topic = {
  name: 'person-career',
  attribute: 'careerHistory',
  schema: object({ positions: citedList({ jobTitle: STRING, employer: STRING, period: NULLABLE_STRING }) }),
  read(output, found) {
    for (const position of records(record(output).positions)) {
      found.add('careerHistory', formatPosition(position), position);
    }
  },
};

const PERSON_SOCIAL_PROFILES: Topic = { ...SOCIAL_PROFILES, name: 'person-social-profiles' };

const PERSON_NEWS: Topic = { ...NEWS, name: 'person-news' };

/** All run in parallel. */
export const PERSON_TOPICS: readonly Topic[] = [PERSON_PROFILE, PERSON_CAREER, PERSON_SOCIAL_PROFILES, PERSON_NEWS];

/** "Chief Financial Officer, Example Corp (2019-present)" */
function formatPosition(position: Json): string | undefined {
  const jobTitle = text(position.jobTitle);
  const employer = text(position.employer);
  if (!jobTitle || !employer) return undefined;
  const period = text(position.period);
  return period ? `${jobTitle}, ${employer} (${period})` : `${jobTitle}, ${employer}`;
}
