// The domain's views: their words for channels without a screen, and their wiring.
import type { Todo } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { registry } from '../catalog.js';
import { CalendarWeekView } from './meeting.js';
import { TodoListView } from './todo.js';

const todo = (title: string, extra: Partial<Todo> = {}): Todo => ({
  id: crypto.randomUUID(),
  title,
  done: false,
  dueOn: null,
  meetingId: null,
  createdBy: 'person',
  createdAt: new Date().toISOString(),
  ...extra,
});

describe('domain views', () => {
  it('render text for a channel without a screen, and a shorter form for voice', () => {
    const p = {
      title: 'Due this week',
      items: [todo('Order tiles', { dueOn: '2026-10-09' }), todo('Call the plumber')],
    };
    expect(TodoListView.text(p, { timeZone: 'UTC' })).toBe(
      'Due this week\n• Order tiles (due Fri 9 Oct)\n• Call the plumber',
    );
    expect(TodoListView.speak(p, { timeZone: 'UTC' })).toBe(
      '2 to-dos: Order tiles, Call the plumber.',
    );
    const many = { items: ['a', 'b', 'c', 'd', 'e'].map((t) => todo(t)) };
    expect(TodoListView.speak(many, { timeZone: 'UTC' })).toBe('5 to-dos: a, b, c, and 2 more.');
  });

  it('are in the app registry, and the week collapses to the day view on a phone', () => {
    expect(registry.getViewDef('todo.list')).toBe(TodoListView);
    expect(registry.getViewDef(CalendarWeekView.collapseTo ?? '')).toBeDefined();
  });

  it('queries are checked against the entity list grammar', () => {
    const ok = registry.checkPresent(
      { kind: 'inline', view: 'todo.list', query: { done: false } },
      ['inline'],
    );
    expect(ok.kind).toBe('show');
    const bad = registry.checkPresent(
      { kind: 'inline', view: 'todo.list', query: { ownerId: 'x' } },
      ['inline'],
    );
    expect(bad.kind).toBe('error');
  });
});
