import { isTimeZone } from '@hykr/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultTimeZone, setDefaultTimeZone, tenantZone } from './time-zone.js';

afterEach(() => setDefaultTimeZone(undefined));

describe('isTimeZone', () => {
  it('knows IANA zones and UTC', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
  });

  it('refuses what is not a zone', () => {
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone('x'.repeat(65))).toBe(false);
    expect(isTimeZone(undefined)).toBe(false);
    expect(isTimeZone(null)).toBe(false);
    expect(isTimeZone(330)).toBe(false);
    expect(isTimeZone({ timeZone: 'UTC' })).toBe(false);
  });
});

describe('the deployment default', () => {
  it('is UTC when the deployment sets none', () => {
    setDefaultTimeZone(undefined);
    expect(defaultTimeZone()).toBe('UTC');
    setDefaultTimeZone('');
    expect(defaultTimeZone()).toBe('UTC');
    setDefaultTimeZone('   ');
    expect(defaultTimeZone()).toBe('UTC');
  });

  it('is the zone the deployment sets', () => {
    setDefaultTimeZone(' Europe/Lisbon ');
    expect(defaultTimeZone()).toBe('Europe/Lisbon');
  });

  it('refuses a name that is not a zone, and keeps the one it had', () => {
    setDefaultTimeZone('Asia/Tokyo');
    expect(() => setDefaultTimeZone('Mars/Olympus')).toThrow(
      'DEFAULT_TIME_ZONE must be an IANA time zone',
    );
    expect(defaultTimeZone()).toBe('Asia/Tokyo');
  });
});

describe('tenantZone', () => {
  it("is the business's own zone", () => {
    setDefaultTimeZone('Asia/Tokyo');
    expect(tenantZone({ timeZone: 'Europe/Berlin' })).toBe('Europe/Berlin');
  });

  it("is the deployment's when the business set none, or one that is not a zone", () => {
    setDefaultTimeZone('Asia/Tokyo');
    expect(tenantZone({})).toBe('Asia/Tokyo');
    expect(tenantZone(undefined)).toBe('Asia/Tokyo');
    expect(tenantZone(null)).toBe('Asia/Tokyo');
    expect(tenantZone({ timeZone: 'Mars/Olympus' })).toBe('Asia/Tokyo');
    expect(tenantZone({ timeZone: 42 })).toBe('Asia/Tokyo');
    expect(tenantZone({ timeZone: null })).toBe('Asia/Tokyo');
  });

  it('is UTC when neither the business nor the deployment set one', () => {
    expect(tenantZone({})).toBe('UTC');
    expect(tenantZone({ timeZone: 'nowhere' })).toBe('UTC');
  });
});
