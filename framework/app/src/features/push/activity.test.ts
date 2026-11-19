import { describe, expect, it, vi } from 'vitest';
import { activityReporter } from './activity';

describe('activity reports', () => {
  it('sends the first at once, then at most one a minute', () => {
    let t = 0;
    const send = vi.fn(async () => undefined);
    const r = activityReporter(send, 60_000, () => t);
    expect(r.ping()).toBe(true);
    t = 30_000;
    expect(r.ping()).toBe(false);
    t = 60_000;
    expect(r.ping()).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a failed report is tried again at the next use', async () => {
    let t = 0;
    const send = vi.fn(async () => {
      throw new Error('offline');
    });
    const r = activityReporter(send, 60_000, () => t);
    r.ping();
    await Promise.resolve();
    await Promise.resolve();
    t = 1;
    expect(r.ping()).toBe(true);
  });
});
