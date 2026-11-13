import { describe, expect, it, vi } from 'vitest';

vi.mock('../runtime', () => ({
  getCatalog: () => ({
    commandByName: (name: string) =>
      name === 'basket.close' ? { verb: { do: 'close', did: 'closed' } } : undefined,
  }),
}));

const { verbOf } = await import('./verbs');

describe('how history says an action', () => {
  it("says the framework's entity actions in words, a state change included", () => {
    expect(verbOf('basket.create')).toMatchObject({ did: 'created', entityAction: true });
    expect(verbOf('basket.update')).toMatchObject({ do: 'change', did: 'changed' });
    // `<entity>.transition` (the states trait): "The assistant moved it", not "transition it".
    expect(verbOf('basket.transition')).toMatchObject({ do: 'move', did: 'moved' });
  });

  it("uses a command's own verb", () => {
    expect(verbOf('basket.close')).toMatchObject({ did: 'closed', entityAction: false });
  });
});
