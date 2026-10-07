import type { Principal } from '@app/contracts';
import { expect, it } from 'vitest';
import { subjectOf } from './subject.js';

it('a person acts for themselves', () => {
  const p: Principal = { actor: { kind: 'user', id: 'alice', role: 'owner' }, scopes: [] };
  expect(subjectOf(p)).toBe('alice');
});

it('the agent acts for the person it names, and for no one otherwise', () => {
  const agent = { actor: { kind: 'agent', id: 'assistant', role: 'agent' }, scopes: [] } as const;
  expect(subjectOf({ ...agent, actingFor: { userId: 'alice' } } as Principal)).toBe('alice');
  expect(subjectOf(agent as unknown as Principal)).toBeNull();
});
