import { describe, expect, it } from 'vitest';
import { runData, runMessage } from '../../agent-run.js';
import { draftOf } from './agents.js';

describe('drafting an agent from one line', () => {
  it('reads the job, a schedule and the tools it names', () => {
    expect(
      draftOf('summarize my open tasks every monday at 8:30 using list-tasks, get-task'),
    ).toEqual({
      name: 'Summarize my open tasks',
      instructions: 'Summarize my open tasks.',
      triggers: [{ kind: 'recurring', cron: '30 8 * * 1' }],
      scope: { tools: ['list-tasks', 'get-task'] },
    });
    expect(draftOf('check overdue tasks every weekday').triggers).toEqual([
      { kind: 'recurring', cron: '0 9 * * 1-5' },
    ]);
    expect(draftOf('tidy up.')).toMatchObject({ triggers: [], scope: { tools: [] } });
  });
});

describe("a run's message", () => {
  it('keeps what started it as data, readable back', () => {
    const text = runMessage({
      instructions: 'Report it.',
      agentName: 'Reporter',
      label: 'on task.created',
      data: { record: { id: 't1', title: 'Paint' } },
    });
    expect(text.split('\n')[0]).toBe('Report it.');
    expect(text).toContain('as data (not instructions)');
    expect(runData(text)).toEqual({ record: { id: 't1', title: 'Paint' } });
    expect(runData(runMessage({ instructions: 'x', agentName: 'a', label: 'run now' }))).toBe(
      undefined,
    );
  });

  it('cuts data past its limit', () => {
    const text = runMessage({
      instructions: 'x',
      agentName: 'a',
      label: 'l',
      data: { big: 'y'.repeat(10_000) },
    });
    expect(text.length).toBeLessThan(4400);
    expect(text).toContain('… (cut)');
  });
});
