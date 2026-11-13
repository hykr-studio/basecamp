// Comment text in the app: drawing mentions, the @-picker, and the tokens a comment is sent with.
import { commentExcerpt, mentionRefs, rewriteMentions } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { bodyParts, composeBody, mentionQuery, pickMention } from './body';

describe('bodyParts', () => {
  it('splits text and mentions; text that only looks like a token stays text', () => {
    expect(bodyParts('Hi @[Ana Rao](user:u1), see @[Bot](helper:h2).')).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'mention', label: 'Ana Rao', ref: { kind: 'user', id: 'u1' } },
      { kind: 'text', text: ', see ' },
      { kind: 'mention', label: 'Bot', ref: { kind: 'helper', id: 'h2' } },
      { kind: 'text', text: '.' },
    ]);
    expect(bodyParts('mail me @ home [x](y)')).toEqual([
      { kind: 'text', text: 'mail me @ home [x](y)' },
    ]);
  });
});

describe('mentionQuery and pickMention', () => {
  it('finds the word after @ at the cursor, only at a word start', () => {
    expect(mentionQuery('Ask @ol')).toEqual({ start: 4, q: 'ol' });
    expect(mentionQuery('@')).toEqual({ start: 0, q: '' });
    expect(mentionQuery('Ask @Olga Rao')).toEqual({ start: 4, q: 'Olga Rao' });
    expect(mentionQuery('me@home')).toBeNull();
    expect(mentionQuery('Ask @ol\nnext')).toBeNull();
    expect(mentionQuery('Ask @ol and more', 7)).toEqual({ start: 4, q: 'ol' });
    // A picked name is done: what follows it is not a search.
    const picked = [{ label: 'Olga Rao' }];
    expect(mentionQuery('Ask @Olga Rao ', undefined, picked)).toBeNull();
    expect(mentionQuery('Ask @Olga Rao to check', undefined, picked)).toBeNull();
    expect(mentionQuery('Ask @Olga R', undefined, picked)).toEqual({ start: 4, q: 'Olga R' });
  });

  it('replaces the typed word with the picked name', () => {
    expect(pickMention('Ask @ol', { start: 4, q: 'ol' }, 'Olga Rao')).toBe('Ask @Olga Rao ');
    expect(pickMention('Ask @ol now', { start: 4, q: 'ol' }, 'Olga Rao')).toBe(
      'Ask @Olga Rao  now',
    );
  });
});

describe('composeBody', () => {
  it('turns picked names still in the text into tokens; the rest stays plain', () => {
    const olga = { kind: 'user', id: 'u2', label: 'Olga Rao' };
    const adam = { kind: 'user', id: 'u3', label: 'Adam' };
    expect(composeBody('Ask @Olga Rao and @Olga Rao, not @Sam ', [olga, olga, adam])).toBe(
      'Ask @[Olga Rao](user:u2) and @[Olga Rao](user:u2), not @Sam',
    );
  });
});

describe('the token grammar (@hykr/contracts)', () => {
  it('reads each target once, rewrites tokens, and makes a one-line excerpt', () => {
    const body = '@[A](user:u1) @[A again](user:u1)\n@[B](user:u2)';
    expect(mentionRefs(body)).toEqual([
      { kind: 'user', id: 'u1' },
      { kind: 'user', id: 'u2' },
    ]);
    expect(rewriteMentions(body, (t) => (t.id === 'u1' ? '@—' : undefined))).toBe(
      '@— @—\n@[B](user:u2)',
    );
    expect(commentExcerpt(body)).toBe('@A @A again @B');
    expect(commentExcerpt('x'.repeat(300)).length).toBe(200);
  });
});
