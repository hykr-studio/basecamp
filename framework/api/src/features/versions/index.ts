import { versionedPlugin } from '@hykr/core';
import { defineFeature } from '../feature.js';
import { VersionsStart } from './start.js';

/**
 * Versions and frozen records (docs/decisions/B6B4.md): the `versioned` entity plugin (a version
 * per write, 409 on a stale one, approvals pinned to the version asked about, frozen records and
 * their children). Revisions are `reviseWithChildren` in a command; GET /api/history/versions
 * lists them.
 */
export const versionsFeature = defineFeature({
  name: 'versions',
  providers: [VersionsStart],
  contributes: { entityPlugins: [versionedPlugin] },
});
