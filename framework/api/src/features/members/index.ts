import { reserveRoutes } from '@hykr/contracts';
import { fieldPolicyPlugin, grantsCleanup, recordGrantKind } from '@hykr/core';
import { defineFeature } from '../feature.js';
import { commandFieldPolicy, FieldPolicyCheck } from './field-policy.js';
import { GrantsController, MembersController } from './members.controller.js';
import { invitesErasure, invitesExport, membersParts } from './privacy.js';

// /api/members and /api/grants are the framework's: no module may claim them.
reserveRoutes('members', 'grants');

/**
 * A business's people and roles (members, roles it defines and edits, invitations), per-record
 * grants (the `granted` access rule and /api/grants), and field policy (fields hidden by
 * capability wherever a record leaves).
 */
export const membersFeature = defineFeature({
  name: 'members',
  controllers: [MembersController, GrantsController],
  providers: [FieldPolicyCheck],
  contributes: {
    grantKinds: [recordGrantKind],
    entityPlugins: [fieldPolicyPlugin],
    writeHooks: [grantsCleanup],
    readProjectors: [commandFieldPolicy],
    erasureContributors: [invitesErasure],
    exportContributors: [invitesExport],
    personalDataParts: membersParts,
  },
});
