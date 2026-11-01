const DAY_MS = 86_400_000;

/** "2025-03-14" and "2025-03-14T09:30:00Z" become "2025-03-14"; invalid or future dates become undefined. */
export function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const day = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/.exec(value.trim())?.[1];
  if (!day) return undefined;
  const date = new Date(`${day}T00:00:00Z`);
  // Rejects impossible days such as 2025-02-30, which Date rolls over.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return undefined;
  // A day of slack for time zones ahead of UTC.
  if (date.getTime() > Date.now() + DAY_MS) return undefined;
  return day;
}
