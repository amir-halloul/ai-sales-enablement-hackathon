import { describe, expect, it } from 'vitest';
import { registrableDomain, sameRegistrableDomain } from './registrable-domain.js';

describe('registrableDomain', () => {
  it.each([
    ['https://www.example.com', 'example.com'],
    ['example.com', 'example.com'],
    ['http://test.example.com', 'example.com'],
    ['HTTP://Shop.Example.co.uk/about?x=1', 'example.co.uk'],
    ['acme.github.io', 'acme.github.io'],
    ['localhost', undefined],
    ['', undefined],
  ])('%s gives %s', (website, domain) => {
    expect(registrableDomain(website)).toBe(domain);
  });

  it('matches subdomains of the same site only', () => {
    expect(sameRegistrableDomain('https://www.example.com', 'test.example.com')).toBe(true);
    expect(sameRegistrableDomain('example.com', 'example.co.uk')).toBe(false);
    expect(sameRegistrableDomain(undefined, undefined)).toBe(false);
  });
});
