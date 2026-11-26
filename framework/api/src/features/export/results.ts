// Who keeps an export's archive: its job is about no record, so only the person it was started
// for reaches it (B11), and only while they may still export. Someone who lost `data.export`
// sees the job without its output and files, so the archive answers 404 to them as well.
import { DATA_EXPORT_JOB, DataExportCapability } from '@hykr/contracts';
import type { ReadProjector } from '@hykr/core';
import { can } from '@hykr/policy';
import { JOB } from '../jobs/info.js';

export const exportResults: ReadProjector = {
  name: 'export.results',
  project(type, value, p) {
    if (type !== JOB || value.kind !== DATA_EXPORT_JOB) return value;
    if (p.actor.kind === 'system' || can(p, DataExportCapability)) return value;
    return { ...value, output: null, files: [] };
  },
};
