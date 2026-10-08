// Templates as code: created at the provider when missing, their review status recorded, and
// never edited under the same name. A stand-in provider; the database is the real one.
import type { ChannelAdapter, RemoteTemplate, TemplateSpec } from '@app/channels';
import { defineTemplate } from '@app/notifications';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pool } from '../support.js';

const { TemplateSync } = await import('../../dist/channels/templates/template-sync.js');
const { sharedDb } = await import('../../dist/infra/db.js');

afterAll(async () => {
  await sharedDb.pool.end();
  await pool.end();
});

/** A provider holding templates in memory: created ones start pending. */
function provider() {
  const held: RemoteTemplate[] = [];
  const adapter = {
    templates: {
      list: async () => held,
      create: async (t: TemplateSpec) => {
        const id = `tpl-${held.length + 1}`;
        held.push({
          id,
          name: t.name,
          language: t.language,
          status: 'PENDING',
          category: t.category,
        });
        return { id };
      },
    },
  } as unknown as ChannelAdapter;
  return { adapter, held };
}

const name = `test_notice_${Date.now()}_v1`;
const v1 = defineTemplate({
  name,
  category: 'utility',
  params: z.object({ what: z.string() }),
  body: { en: 'Notice: {{what}}.', hi: 'सूचना: {{what}}।', te: 'నోటీసు: {{what}}.' },
  example: { what: 'the office is closed' },
});

describe('templates:sync', () => {
  it('creates what is missing, then records what the provider decides', async () => {
    const { adapter, held } = provider();
    const sync = new TemplateSync(sharedDb.db, adapter, 'http://app', [v1]);
    const first = await sync.run({ create: true });
    expect(first.created).toEqual([`${name}/en`, `${name}/hi`, `${name}/te`]);
    expect(await sync.approved(name, 'en')).toBe(false);

    for (const t of held) t.status = t.language === 'te' ? 'REJECTED' : 'APPROVED';
    held[2].rejectedReason = 'INVALID_FORMAT';
    const again = await sync.run({ create: true });
    expect(again.created).toEqual([]);
    expect(await sync.approved(name, 'en')).toBe(true);
    const { rows } = await pool.query(
      `select language, status, rejected_reason from channel.templates where name = $1 order by language`,
      [name],
    );
    expect(rows).toEqual([
      { language: 'en', status: 'APPROVED', rejected_reason: null },
      { language: 'hi', status: 'APPROVED', rejected_reason: null },
      { language: 'te', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' },
    ]);
  });

  it('changing an approved template under the same name fails: bump the version', async () => {
    const { adapter } = provider();
    const edited = { ...v1, body: { ...v1.body, en: 'Please note: {{what}}.' } };
    const report = await new TemplateSync(sharedDb.db, adapter, 'http://app', [edited]).run({
      create: true,
    });
    expect(report.errors).toEqual([expect.stringContaining('bump the version')]);
    expect(report.errors[0]).toContain(name.replace(/_v1$/, '_v2'));
  });
});
