import type { BadRequestException } from '@nestjs/common';
import { invalidRequest } from './enrichment.errors.js';
import { decodeEntityId, DUNS_NUMBER_PATTERN, STORED_ENTITY_ID_PATTERN, ZOOMINFO_ID_PATTERN } from './entity-id.js';
import type { EntityType, IdentifyRequest } from './enrichment.types.js';
import type { EntityRef } from './providers/provider.js';

const MAX_LENGTH = { name: 300, address: 500, website: 2048, entityId: 200, zoomInfoId: 19, dunsNumber: 9 };

/** What to enrich: an entity of the entity table, or provider IDs (which a stateless entityId encodes). */
export type EnrichTarget = { kind: 'stored'; entityId: string; entityType: EntityType | undefined } | { kind: 'ids'; ref: EntityRef };

export interface EnrichRequest {
  target: EnrichTarget;
  /** Skips the cache and fetches every source again. */
  refresh: boolean;
}

export function parseIdentifyRequest(raw: unknown): IdentifyRequest {
  const body = new BodyReader(raw, ['entityType', 'name', 'address', 'company', 'website']);
  const entityType = body.entityType({ required: true });
  const name = body.string('name', MAX_LENGTH.name, { required: true });
  const address = body.string('address', MAX_LENGTH.address);
  const company = body.string('company', MAX_LENGTH.name);
  const website = body.string('website', MAX_LENGTH.website);

  if (company !== undefined && entityType === 'company') body.fail('company is only allowed when entityType is person');
  if (website !== undefined && !isWebsite(website)) body.fail('website must be an http(s) URL or a domain');

  if (body.hasErrors() || !entityType || !name) throw body.error();
  return { entityType, name, address, company, website };
}

/** Reads an entityId, or a zoomInfoId and/or a dunsNumber. */
export function parseEnrichRequest(raw: unknown): EnrichRequest {
  const body = new BodyReader(raw, ['entityId', 'zoomInfoId', 'dunsNumber', 'entityType', 'refresh']);
  const entityType = body.entityType({ required: false });
  const entityId = body.string('entityId', MAX_LENGTH.entityId);
  const zoomInfoId = body.string('zoomInfoId', MAX_LENGTH.zoomInfoId);
  const dunsNumber = body.string('dunsNumber', MAX_LENGTH.dunsNumber);
  const refresh = body.boolean('refresh') ?? false;

  const hasProviderId = zoomInfoId !== undefined || dunsNumber !== undefined;
  if ((entityId !== undefined) === hasProviderId) {
    body.fail('provide either entityId, or zoomInfoId and/or dunsNumber');
    throw body.error();
  }
  // Its type is checked once the entity is read from the table.
  if (entityId !== undefined && STORED_ENTITY_ID_PATTERN.test(entityId)) {
    if (body.hasErrors()) throw body.error();
    return { target: { kind: 'stored', entityId, entityType }, refresh };
  }

  let ref: EntityRef | null;
  if (entityId !== undefined) {
    ref = decodeEntityId(entityId);
    if (!ref) body.fail('entityId is not valid');
    else if (entityType && entityType !== ref.entityType) body.fail(`entityType does not match entityId (${ref.entityType})`);
  } else {
    if (zoomInfoId !== undefined && !ZOOMINFO_ID_PATTERN.test(zoomInfoId)) body.fail('zoomInfoId must be numeric');
    if (dunsNumber !== undefined && !DUNS_NUMBER_PATTERN.test(dunsNumber)) body.fail('dunsNumber must be 9 digits');
    if (dunsNumber !== undefined && entityType === 'person') body.fail('dunsNumber identifies a company, not a person');
    ref = { entityType: entityType ?? 'company', zoomInfoId: zoomInfoId ?? null, dunsNumber: dunsNumber ?? null };
  }

  if (body.hasErrors() || !ref) throw body.error();
  return { target: { kind: 'ids', ref }, refresh };
}

/** Reads a JSON body field by field and collects every problem, so the caller sees all of them at once. */
class BodyReader {
  private readonly body: Record<string, unknown> = {};
  private readonly errors: string[] = [];

  constructor(raw: unknown, allowedFields: string[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.fail('body must be a JSON object');
      return;
    }
    this.body = raw as Record<string, unknown>;
    for (const field of Object.keys(this.body)) {
      if (!allowedFields.includes(field)) this.fail(`${field} is not a supported field`);
    }
  }

  /** Returns the trimmed value; null and blank count as absent, since Salesforce Apex sends empty fields that way. */
  string(field: string, maxLength: number, { required = false } = {}): string | undefined {
    const value = this.body[field] ?? '';
    if (typeof value !== 'string') {
      this.fail(`${field} must be a string`);
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      if (required) this.fail(`${field} is required`);
      return undefined;
    }
    if (trimmed.length > maxLength) {
      this.fail(`${field} must be at most ${maxLength} characters`);
      return undefined;
    }
    return trimmed;
  }

  /** null counts as absent, like for strings. */
  boolean(field: string): boolean | undefined {
    const value = this.body[field] ?? undefined;
    if (value === undefined || typeof value === 'boolean') return value;
    this.fail(`${field} must be true or false`);
    return undefined;
  }

  entityType({ required }: { required: boolean }): EntityType | undefined {
    const value = this.body.entityType;
    if (value === 'company' || value === 'person') return value;
    if (value !== undefined && value !== null) this.fail('entityType must be company or person');
    else if (required) this.fail('entityType is required');
    return undefined;
  }

  fail(message: string): void {
    this.errors.push(message);
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  error(): BadRequestException {
    return invalidRequest(this.errors);
  }
}

function isWebsite(value: string): boolean {
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
  try {
    const url = new URL(hasScheme ? value : `https://${value}`);
    const isHttp = url.protocol === 'https:' || url.protocol === 'http:';
    const isDomainName = /^[a-z\d-]+(\.[a-z\d-]+)+$/i.test(url.hostname);
    return isHttp && isDomainName;
  } catch {
    return false;
  }
}
