import {
  CloseMeetingSpec,
  MeetingSpec,
  NoteSpec,
  RescheduleMeetingSpec,
  TodoSpec,
} from '@app/contracts';
import { commandTools, entityTools } from '@app/core/tools';
import { apiFor } from '../context.js';

/**
 * The agent's tools come from the same declarations the API serves. Adding an entity or
 * a command adds its tools here with no agent code.
 */
export const tools = {
  ...entityTools(TodoSpec, apiFor),
  ...entityTools(NoteSpec, apiFor),
  ...entityTools(MeetingSpec, apiFor),
  ...commandTools([CloseMeetingSpec, RescheduleMeetingSpec], apiFor),
};
