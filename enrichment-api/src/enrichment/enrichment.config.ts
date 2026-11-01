export const ENRICHMENT_CONFIG = Symbol('ENRICHMENT_CONFIG');

export interface EnrichmentConfig {
  /** Total time budget of one API request across all providers. */
  requestBudgetMs: number;
}

// Web search prompts take 25-55 s after the ZoomInfo lookup; Salesforce callouts allow up to 120 s.
const DEFAULT_REQUEST_BUDGET_MS = 90_000;

export function loadEnrichmentConfig(env: NodeJS.ProcessEnv = process.env): EnrichmentConfig {
  const raw = env.ENRICHMENT_REQUEST_BUDGET_MS?.trim();
  if (!raw) return { requestBudgetMs: DEFAULT_REQUEST_BUDGET_MS };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000 || value > 120_000) {
    throw new Error('ENRICHMENT_REQUEST_BUDGET_MS must be an integer between 1000 and 120000');
  }
  return { requestBudgetMs: value };
}
