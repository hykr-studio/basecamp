import { atLevel, defineLevelRule } from '@hykr/core';
import { Levels } from '../../../server/approval-levels.js';

/** Every to-do write is an internal change: done at once, and it can be undone for a moment. */
export const TodoLevels = defineLevelRule({
  name: 'todos.levels',
  on: ['todo.*'],
  decide: () => atLevel(Levels.internal.name, 'todo_internal', 'A change to your to-dos'),
});
