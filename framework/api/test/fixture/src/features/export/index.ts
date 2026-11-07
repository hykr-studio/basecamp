// The export feature in use (A11X): the fixture's tasks and visits, with
// - a platform flag that switches the visits module off (an export skips it until it is on);
// - a task field (`dueOn`) hidden from everyone without `fixture.due.read`, which only admins
//   have, so an owner's export leaves it out;
// - an export source, `fixture-notes`, whose rows name the person they are read for and whose
//   `secret` the same capability hides; `exportGate` holds it, so a test can keep an export
//   running.
// Only the export test's server (`exportApp`) adds these; no table of its own.
import { type DataExportSource, defineServer } from '@hykr/api';
import { type Contributions, defineCapability, defineFeatureFlag } from '@hykr/contracts';
import type { ReadProjector } from '@hykr/core';
import { can } from '@hykr/policy';
import { fixture } from '../../index.js';

/** Sees a task's due date. */
export const SeeDueDates = defineCapability({
  name: 'fixture.due.read',
  label: { en: 'See due dates', hi: 'नियत तारीख़ देखें', te: 'గడువు తేదీలు చూడండి' },
  roles: ['admin'],
});

/** The visits module, off unless the platform switches it on for a business. */
export const VisitsFlag = defineFeatureFlag({
  key: 'fixture.visits',
  label: { en: 'Visits', hi: 'विज़िट', te: 'సందర్శనలు' },
  gates: { modules: ['visits'] },
});

const sees = (p: Parameters<ReadProjector['project']>[2]) => can(p, SeeDueDates);

/** A task's due date and a note's secret, only for those who see due dates. */
export const hideDueDates: ReadProjector = {
  name: 'fixture.export.hidden',
  project(type, value, p) {
    if (type === 'task' && !sees(p)) {
      const { dueOn: _hidden, ...rest } = value;
      return rest;
    }
    if (type === 'fixture-notes' && !sees(p)) {
      const { secret: _hidden, ...rest } = value;
      return rest;
    }
    return value;
  },
};

/** While `hold` is set, the notes source waits for it: an export stays running. */
export const exportGate: { hold?: Promise<void> } = {};

/** Rows no entity serves: one note for whoever the export is read as. */
export const notesSource: DataExportSource = {
  name: 'fixture-notes',
  async *rows({ principal, tenantId }) {
    if (exportGate.hold) await exportGate.hold;
    yield {
      tenantId,
      readAs: principal.actor.id,
      note: '=SUM(1,2)',
      secret: 'kept for admins',
      at: new Date('2026-01-02T03:04:05.000Z'),
    };
  },
};

export const exportContributions: Partial<Contributions> = {
  capabilities: [SeeDueDates],
  featureFlags: [VisitsFlag],
  readProjectors: [hideDueDates],
  dataExportSources: [notesSource],
};

/** The fixture, with the export test's flag, hidden field and source. */
export const exportApp = defineServer({
  ...fixture.definition,
  contributes: exportContributions,
});
