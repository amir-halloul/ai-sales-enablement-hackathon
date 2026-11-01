import { describe, expect, it } from 'vitest';
import { isAllowedUrl, isPublicAddress, publicOnlyLookup } from './safe-fetch.js';

describe('isPublicAddress', () => {
  it.each(['93.184.215.14', '2606:4700::6810:84e5'])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('isAllowedUrl', () => {
  it.each(['https://www.example.com/about', 'http://example.com/', 'https://93.184.215.14/'])('allows %s', (url) => {
    expect(isAllowedUrl(new URL(url))).toBe(true);
  });

  it.each([
    'ftp://example.com/',
    'file:///etc/passwd',
    'https://user:secret@example.com/',
    'https://example.com:8443/',
    'http://localhost/',
    'http://intranet/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
  ])('blocks %s', (url) => {
    expect(isAllowedUrl(new URL(url))).toBe(false);
  });
});

describe('publicOnlyLookup', () => {
  it('fails for a host name that resolves to a private address', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      publicOnlyLookup('localhost', {}, (err) => resolve(err));
    });
    expect(error?.code).toBe('EBLOCKED');
  });
});
