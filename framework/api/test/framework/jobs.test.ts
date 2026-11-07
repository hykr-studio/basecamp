// Long-running jobs (B11), without booting the app: the callback signature, the per-job secret,
// defineJob's checks, the update format, and the guard on result URLs.
import { JobUpdate } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertJobsConfig,
  callbackSecret,
  callbackUrl,
  jobsConfig,
} from '../../dist/features/jobs/config.js';
import { defineJob } from '../../dist/features/jobs/define.js';
import { checkResultUrl, isPrivateAddress, ResultRefused } from '../../dist/features/jobs/fetch.js';
import { signJobCallback, verifyJobCallback } from '../../dist/features/jobs/signature.js';

const SECRET = 'a'.repeat(64);
const body = Buffer.from(JSON.stringify({ status: 'running', progress: 10 }));
const check = (header: string | undefined, raw: Buffer | string = body, now?: number) =>
  verifyJobCallback(SECRET, raw, header, { toleranceS: 300, now });

describe('the callback signature', () => {
  it('a body signed with the secret, now, is genuine', () => {
    const header = signJobCallback(SECRET, body);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(check(header)).toMatchObject({ ok: true });
  });

  it('another body, another secret, or no header: refused', () => {
    const header = signJobCallback(SECRET, body);
    expect(check(header, `${body}x`)).toEqual({ ok: false, reason: 'mismatch' });
    expect(check(signJobCallback('b'.repeat(64), body))).toEqual({ ok: false, reason: 'mismatch' });
    expect(check(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(check('')).toEqual({ ok: false, reason: 'missing' });
  });

  it('a stale or future timestamp: refused, even when the HMAC matches', () => {
    const now = Date.now();
    const old = Math.floor(now / 1000) - 301;
    expect(check(signJobCallback(SECRET, body, old), body, now)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(check(signJobCallback(SECRET, body, old + 602), body, now)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(check(signJobCallback(SECRET, body, old + 2), body, now)).toMatchObject({ ok: true });
  });

  it('malformed headers: refused', () => {
    for (const header of ['v1=abc', 't=x,v1=abc', 't=123', 'nonsense', 't=123,v1=zz'])
      expect(check(header).ok, header).toBe(false);
  });

  it('a second v1 (a rotation) may match', () => {
    const [t, v1] = signJobCallback(SECRET, body).split(',');
    expect(check(`${t},v1=${'0'.repeat(64)},${v1}`)).toMatchObject({ ok: true });
  });
});

describe('configuration', () => {
  it('each job has its own secret, derived, never the shared one', () => {
    const c = jobsConfig({ BETTER_AUTH_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv);
    const one = callbackSecret(c.secret, 'job-1');
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(callbackSecret(c.secret, 'job-2')).not.toBe(one);
    expect(one).not.toBe(c.secret);
    const other = jobsConfig({ BETTER_AUTH_SECRET: 'y'.repeat(40) } as NodeJS.ProcessEnv);
    expect(callbackSecret(other.secret, 'job-1')).not.toBe(one);
  });

  it('the callback URL is under the public address', () => {
    const c = jobsConfig({ JOBS_PUBLIC_URL: 'https://api.example.test/' } as NodeJS.ProcessEnv);
    expect(callbackUrl(c.publicUrl, 'abc')).toBe('https://api.example.test/api/jobs/abc/callback');
    expect(jobsConfig({ BETTER_AUTH_URL: 'http://h:1' } as NodeJS.ProcessEnv).publicUrl).toBe(
      'http://h:1',
    );
  });

  it('refuses a short secret, and private URLs in production', () => {
    const env = { JOBS_SECRET: 'short' } as NodeJS.ProcessEnv;
    expect(() => assertJobsConfig(jobsConfig(env), env)).toThrow('at least 32');
    const prod = { NODE_ENV: 'production', JOBS_ALLOW_PRIVATE_URLS: '1' } as NodeJS.ProcessEnv;
    expect(() => assertJobsConfig(jobsConfig(prod), prod)).toThrow('development');
  });
});

describe('defineJob', () => {
  const base = {
    name: 'test.render',
    description: 'Renders.',
    input: z.object({}),
    timeoutMs: 60_000,
    submit: async () => undefined,
  };

  it('checks the name, the description and the numbers', () => {
    expect(defineJob(base).name).toBe('test.render');
    expect(() => defineJob({ ...base, name: 'Render Things' })).toThrow('lower case');
    expect(() => defineJob({ ...base, name: `a.${'b'.repeat(70)}` })).toThrow('64');
    expect(() => defineJob({ ...base, description: ' ' })).toThrow('describe');
    expect(() => defineJob({ ...base, timeoutMs: 0 })).toThrow('timeoutMs');
    expect(() => defineJob({ ...base, timeoutMs: undefined as unknown as number })).toThrow(
      'timeoutMs',
    );
    expect(() => defineJob({ ...base, maxFiles: 1.5 })).toThrow('maxFiles');
  });

  it('polling needs poll, at least a second apart; about needs an id', () => {
    expect(() => defineJob({ ...base, pollEveryMs: 5_000 })).toThrow('without poll');
    expect(() => defineJob({ ...base, poll: async () => null, pollEveryMs: 10 })).toThrow(
      'at least 1000',
    );
    expect(() =>
      defineJob({ ...base, about: { entity: 'thing' } as unknown as typeof base & never }),
    ).toThrow('about');
  });
});

describe('the update format', () => {
  it('reads progress, success with files, failure and cancellation', () => {
    expect(JobUpdate.parse({ status: 'running', progress: 42.5, message: 'Half' })).toEqual({
      status: 'running',
      progress: 42.5,
      message: 'Half',
    });
    expect(
      JobUpdate.parse({
        status: 'succeeded',
        output: { n: 1 },
        files: [
          { name: 'a.png', mime: 'image/png', data: 'aGk=' },
          { name: 'b.png', mime: 'IMAGE/PNG', url: 'https://x.test/b.png' },
        ],
      }),
    ).toMatchObject({ files: [{ mime: 'image/png' }, { mime: 'image/png' }] });
    expect(JobUpdate.parse({ status: 'failed', error: { message: 'No' } })).toMatchObject({
      status: 'failed',
    });
    expect(JobUpdate.parse({ status: 'cancelled' })).toEqual({ status: 'cancelled' });
  });

  it('refuses an unknown status, progress past 100, a file with both or neither source', () => {
    expect(JobUpdate.safeParse({ status: 'done' }).success).toBe(false);
    expect(JobUpdate.safeParse({ status: 'running', progress: 101 }).success).toBe(false);
    const file = (f: object) =>
      JobUpdate.safeParse({ status: 'succeeded', files: [{ name: 'a', mime: 'text/plain', ...f }] })
        .success;
    expect(file({})).toBe(false);
    expect(file({ data: 'aGk=', url: 'https://x.test/a' })).toBe(false);
    expect(file({ url: 'ftp://x.test/a' })).toBe(false);
    expect(file({ data: 'aGk=' })).toBe(true);
  });
});

describe('result URLs', () => {
  it('private, loopback, link-local and unique-local addresses are private', () => {
    for (const a of [
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
      'not an address',
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['93.184.216.34', '8.8.8.8', '2606:4700::1111'])
      expect(isPrivateAddress(a), a).toBe(false);
  });

  it('only https to public addresses, unless private URLs are allowed (development)', async () => {
    const strict = { allowPrivate: false };
    await expect(checkResultUrl('http://93.184.216.34/a.png', strict)).rejects.toBeInstanceOf(
      ResultRefused,
    );
    await expect(checkResultUrl('https://127.0.0.1/a.png', strict)).rejects.toThrow('private');
    await expect(checkResultUrl('https://[::1]/a.png', strict)).rejects.toThrow('private');
    await expect(checkResultUrl('https://localhost/a.png', strict)).rejects.toThrow('private');
    await expect(checkResultUrl('https://u:p@93.184.216.34/a', strict)).rejects.toThrow(
      'credentials',
    );
    await expect(checkResultUrl('not a url', strict)).rejects.toThrow('not a URL');
    expect((await checkResultUrl('https://93.184.216.34/a.png', strict)).href).toBe(
      'https://93.184.216.34/a.png',
    );
    const dev = { allowPrivate: true };
    expect((await checkResultUrl('http://127.0.0.1:9/a.png', dev)).port).toBe('9');
    await expect(checkResultUrl('file:///etc/passwd', dev)).rejects.toBeInstanceOf(ResultRefused);
  });
});
