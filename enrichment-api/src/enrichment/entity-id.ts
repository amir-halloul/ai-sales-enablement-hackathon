import { randomUUID } from 'node:crypto';
import type { EntityRef } from './providers/provider.js';

export const ZOOMINFO_ID_PATTERN = /^\d{1,19}$/;
export const DUNS_NUMBER_PATTERN = /^\d{9}$/;
/** An entity in the entity table. A stateless ID never matches: its payload starts with "WzE" ("[1"). */
export const STORED_ENTITY_ID_PATTERN = /^ent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PREFIX = 'ent_';
const VERSION = 1;

export function newStoredEntityId(): string {
  return PREFIX + randomUUID();
}

// Stateless IDs encode the provider IDs, so any replica can resolve them. Used for the Identify candidates, and
// for every ID when no entity table is configured.
export function encodeEntityId(ref: EntityRef): string {
  const payload = [VERSION, ref.entityType === 'company' ? 'c' : 'p', ref.zoomInfoId, ref.dunsNumber];
  return PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeEntityId(entityId: string): EntityRef | null {
  if (!entityId.startsWith(PREFIX) || entityId.length > 200) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(entityId.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(payload) || payload.length !== 4 || payload[0] !== VERSION) return null;
  const [, type, zoomInfoId, dunsNumber] = payload as unknown[];
  if (type !== 'c' && type !== 'p') return null;
  if (!isId(zoomInfoId, ZOOMINFO_ID_PATTERN) || !isId(dunsNumber, DUNS_NUMBER_PATTERN)) return null;
  if (zoomInfoId === null && dunsNumber === null) return null;
  if (type === 'p' && dunsNumber !== null) return null;

  const ref: EntityRef = { entityType: type === 'c' ? 'company' : 'person', zoomInfoId, dunsNumber };
  return encodeEntityId(ref) === entityId ? ref : null;
}

function isId(value: unknown, pattern: RegExp): value is string | null {
  return value === null || (typeof value === 'string' && pattern.test(value));
}
