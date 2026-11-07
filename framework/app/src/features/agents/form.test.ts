import { describe, expect, it } from 'vitest';
import { blankTrigger, draftOf, inputOf, newDraft, triggerWords } from './form';

describe('the agent form', () => {
  it('round-trips a definition through the fields', () => {
    const agent = {
      id: 'a1',
      name: 'Monday',
      description: '',
      instructions: 'Count my open tasks.',
      ownerId: 'u1',
      triggers: [
        { kind: 'recurring' as const, cron: '0 9 * * 1' },
        { kind: 'event' as const, on: ['task.created'], where: { done: false } },
        { kind: 'condition' as const, entity: 'task', where: { done: false }, everyMinutes: 30 },
        { kind: 'message' as const, contains: ['price'] },
        { kind: 'mention' as const },
      ],
      scope: { tools: ['list-tasks'] },
      budget: { period: 'week' as const, runs: 5, maxSteps: 4 },
      status: 'active' as const,
      template: null,
      createdBy: 'person' as const,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    const made = inputOf(draftOf(agent));
    expect(made).toEqual({
      input: {
        name: 'Monday',
        description: '',
        instructions: 'Count my open tasks.',
        triggers: agent.triggers,
        scope: { tools: ['list-tasks'] },
        budget: { period: 'week', runs: 5, maxSteps: 4 },
      },
    });
  });

  it('says what to fix', () => {
    expect(inputOf(newDraft())).toEqual({ error: 'Give the agent a name' });
    const draft = { ...newDraft(), name: 'x', instructions: 'y' };
    expect(inputOf({ ...draft, triggers: [{ ...blankTrigger('once'), when: 'soon' }] })).toEqual({
      error: 'Once: give a date and time',
    });
    expect(
      inputOf({ ...draft, triggers: [{ ...blankTrigger('event'), list: 'a.b', where: '{x' }] }),
    ).toEqual({ error: 'The event’s condition is not JSON' });
  });

  it('words each trigger', () => {
    expect(triggerWords({ kind: 'event', on: ['task.created', 'task.updated'] })).toBe(
      'When task.created or task.updated happens',
    );
    expect(triggerWords({ kind: 'message' })).toBe('On any WhatsApp message');
  });
});
