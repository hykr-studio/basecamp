/**
 * Ready-made agents the meetings module offers a business (A6): what each does, what starts it
 * and the tools it may use are this application's choice; the framework only runs them. The
 * scripted model's scripts for their runs are in scripts.ts.
 */
import { defineAgentTemplate } from '@hykr/api';

/** Every Monday at 09:00 (the business's time): the open to-dos, in one message. */
export const WeeklyTodos = defineAgentTemplate({
  key: 'meetings.weekly-todos',
  name: {
    en: 'Monday: open to-dos',
    hi: 'सोमवार: खुले काम',
    te: 'సోమవారం: తెరిచి ఉన్న పనులు',
  },
  description: {
    en: 'Every Monday at 09:00, a summary of your open to-dos.',
    hi: 'हर सोमवार सुबह 9 बजे, आपके खुले कामों का सारांश।',
    te: 'ప్రతి సోమవారం ఉదయం 9 గంటలకు, మీ తెరిచి ఉన్న పనుల సారాంశం.',
  },
  instructions: 'Summarize my open to-dos.',
  triggers: [{ kind: 'recurring', cron: '0 9 * * 1' }],
  scope: { tools: ['list-todos'] },
  budget: { period: 'month', runs: 10 },
});

/** When a meeting is closed: a follow-up note on it, listing its open to-dos. */
export const MeetingFollowUp = defineAgentTemplate({
  key: 'meetings.follow-up',
  name: {
    en: 'Meeting closed: draft a follow-up',
    hi: 'मीटिंग बंद: फ़ॉलो-अप का मसौदा',
    te: 'మీటింగ్ ముగిసింది: ఫాలో-అప్ ముసాయిదా',
  },
  description: {
    en: 'When a meeting is closed, a follow-up note on it with its open to-dos.',
    hi: 'मीटिंग बंद होने पर, उसके खुले कामों के साथ एक फ़ॉलो-अप नोट।',
    te: 'మీటింగ్ ముగిసినప్పుడు, దాని తెరిచి ఉన్న పనులతో ఒక ఫాలో-అప్ నోట్.',
  },
  instructions: 'Draft a follow-up note for the meeting that closed.',
  triggers: [{ kind: 'event', on: ['meeting.closed'] }],
  scope: { tools: ['list-todos', 'create-note'] },
  budget: { period: 'month', runs: 200 },
});

export const meetingsAgentTemplates = [WeeklyTodos, MeetingFollowUp];
