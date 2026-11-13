// Why a reply failed, as the thread says it: a turn the credits refused, in the app's language.
import { describe, expect, it } from 'vitest';
import { replyError } from './replyError';

const refusedBy = (rule: string, reason: string) =>
  new Error(JSON.stringify({ error: 'turn_refused', rule, reason }));
const PAUSED = 'असिस्टेंट रुका हुआ है';
const SUSPENDED = 'असिस्टेंट रुका हुआ है: ऑपरेटर';
/** The app's sentence for a credits rule: the operator's pause has its own. */
const said = (rule: string) => (rule === 'credits_suspended' ? SUSPENDED : PAUSED);

describe('a refused turn', () => {
  it("by the business's credits reads the app's own words, never the API's English reason", () => {
    const limit = refusedBy(
      'usage_limit_reached',
      "Assistant actions: this period's limit is reached",
    );
    expect(replyError(limit, said)).toBe(PAUSED);
    expect(replyError(refusedBy('credits_exhausted', 'Used 100%'), said)).toBe(PAUSED);
  });
  it("by the operator's pause reads its own words: adding credits would not lift it", () => {
    expect(replyError(refusedBy('credits_suspended', 'Paused by its operator'), said)).toBe(
      SUSPENDED,
    );
  });
  it("by anything else reads the API's reason", () => {
    const model = refusedBy('model_not_allowed', 'This business does not allow that model');
    expect(replyError(model, said)).toBe('This business does not allow that model');
  });
});
