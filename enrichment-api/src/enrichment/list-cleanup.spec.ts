import { describe, expect, it } from 'vitest';
import type { AttributedValue, NewsHeadline } from './enrichment.types.js';
import { cleanNews, cleanProducts, productKey } from './list-cleanup.js';

const ZI = [{ sourceType: 'zoominfo', sourceReference: '100' }] as const;

const product = (value: string): AttributedValue<string> => ({ value, confidence: 'medium', sources: [...ZI] });
const news = (value: string, date: string | null): NewsHeadline => ({ value, date, confidence: 'medium', sources: [...ZI] });

describe('list cleanup', () => {
  it('drops generic, empty and self-referencing product names', () => {
    const products = ['Services', 'Solutions', 'N/A', '-', 'X', 'Example Corp', 'Payroll', 'Cloud ERP'].map(product);

    expect(cleanProducts(products, 'Example Corp').map((p) => p.value)).toEqual(['Payroll', 'Cloud ERP']);
  });

  it('compares product names without case, punctuation or plural', () => {
    expect(productKey('Cloud-Services')).toBe(productKey('cloud service'));
    expect(productKey('R&D Consulting')).toBe(productKey('R and D consulting'));
    expect(productKey('Business')).not.toBe(productKey('Busines'));
  });

  it('keeps the last 24 months of news, newest first, undated last', () => {
    const today = new Date('2026-10-08T12:00:00Z');
    const items = [news('Undated', null), news('Old', '2024-10-07'), news('Older but kept', '2024-10-08'), news('Recent', '2026-09-30')];

    expect(cleanNews(items, today).map((n) => n.value)).toEqual(['Recent', 'Older but kept', 'Undated']);
  });
});
