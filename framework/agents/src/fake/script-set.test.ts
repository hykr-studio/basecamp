import { describe, expect, it } from 'vitest';
import { defineScript, say } from './engine.js';
import { platformScripts } from './platform-scripts.js';
import { defineScriptSet, orderScriptSets } from './script-set.js';

const script = (name: string) =>
  defineScript({ name, match: () => undefined, step: () => [say(name)] });

describe('script sets', () => {
  it('run by order, then name, each keeping its own script order', () => {
    const sets = [
      defineScriptSet({ name: 'late', order: 900, scripts: [script('z')] }),
      defineScriptSet({ name: 'b', order: 100, scripts: [script('b1'), script('b2')] }),
      defineScriptSet({ name: 'a', order: 100, scripts: [script('a2'), script('a1')] }),
    ];
    expect(orderScriptSets(sets).map((s) => s.name)).toEqual(['a2', 'a1', 'b1', 'b2', 'z']);
  });

  it('refuse a set or a script named twice', () => {
    const one = defineScriptSet({ name: 'one', order: 1, scripts: [script('x')] });
    expect(() => orderScriptSets([one, { ...one, order: 2, scripts: [] }])).toThrow(/"one"/);
    const two = defineScriptSet({ name: 'two', order: 2, scripts: [script('x')] });
    expect(() => orderScriptSets([one, two])).toThrow(/"x"/);
  });

  it('keep the platform scripts in their order (draft-reply before request-human)', () => {
    expect(platformScripts.map((s) => s.name)).toEqual([
      'save-page',
      'open-page',
      'draft-reply',
      'request-human',
      'file-words',
      'file-about',
      'file-only',
      'document-status',
      'job-status',
      'jobs-running',
      'comments-list',
      'comments-add',
      'comments-mentionable',
      'remember',
      'recall',
      'apply-transition',
      'fail',
    ]);
  });
});
