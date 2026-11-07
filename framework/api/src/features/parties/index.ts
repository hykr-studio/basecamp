import { reserveRoutes } from '@hykr/contracts';
import { participantGrantKind, participationsCleanup } from '@hykr/core';
import { defineFeature } from '../feature.js';
import { ParticipantRolesCheck, partiesErasure, partiesExport } from './contributors.js';
import { ParticipantsController, PartiesController } from './parties.controller.js';

// /api/parties and /api/participants are the framework's: no module may claim them.
reserveRoutes('parties', 'participants');

/**
 * The people and organisations a business works with who are not on its team (parties), how
 * each is reached (members: a WhatsApp number, an account), and who participates in which record
 * in which participant role (the `participant` access rule and /api/participants). Participant
 * roles are the application's (`participantRoles`).
 */
export const partiesFeature = defineFeature({
  name: 'parties',
  controllers: [PartiesController, ParticipantsController],
  providers: [ParticipantRolesCheck],
  contributes: {
    grantKinds: [participantGrantKind],
    writeHooks: [participationsCleanup],
    erasureContributors: [partiesErasure],
    exportContributors: [partiesExport],
  },
});
