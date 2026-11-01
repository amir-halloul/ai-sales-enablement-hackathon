import type { CacheStore, StoredValue } from './source-cache.js';

/** The cache table in memory, for tests. */
export class InMemoryCacheStore implements CacheStore {
  readonly rows = new Map<string, StoredValue & { source: string }>();
  available = true;

  isAvailable(): boolean {
    return this.available;
  }

  read(key: string): Promise<StoredValue | null> {
    return Promise.resolve(this.rows.get(key) ?? null);
  }

  write(key: string, source: string, value: unknown): Promise<void> {
    // Stored as JSON, like the VARIANT column.
    this.rows.set(key, { source, value: JSON.parse(JSON.stringify(value)) as unknown, fetchedAtMs: Date.now() });
    return Promise.resolve();
  }
}
