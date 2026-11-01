import { describe, expect, it } from 'vitest';
import { isoDate } from './iso-date.js';

describe('isoDate', () => {
  it.each([
    ['2025-03-14', '2025-03-14'],
    ['2025-03-14T09:30:00Z', '2025-03-14'],
    [' 2025-03-14 09:30 ', '2025-03-14'],
    ['2025-02-30', undefined],
    ['2025-03', undefined],
    ['March 14, 2025', undefined],
    ['2999-01-01', undefined],
    [null, undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(isoDate(value)).toBe(expected);
  });
});
