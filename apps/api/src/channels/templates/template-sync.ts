import type { ChannelAdapter, RemoteTemplate } from '@app/channels';
import { type Database, schema } from '@app/db';
import { LANGS, type Lang } from '@app/i18n';
import {
  contentHash,
  notifications,
  type TemplateDef,
  templates,
  toTemplateSpec,
} from '@app/notifications';
import { and, eq } from 'drizzle-orm';

const { templates: stored } = schema;

export type SyncReport = {
  created: string[];
  statuses: { template: string; status: string; reason?: string }[];
  /** Templates whose words changed under the same name: a new version is needed. */
  errors: string[];
};

const key = (name: string, lang: string) => `${name}/${lang}`;

/**
 * Keeps the provider's templates in step with the code. For every template and language:
 * missing → create it (pending review); same content → nothing; changed content under the same
 * name → refuse ("bump the version": an edit would take an approved template out of service);
 * and record what the provider says (approved, rejected and why, paused).
 */
export class TemplateSync {
  constructor(
    private readonly db: Database,
    private readonly wa: ChannelAdapter,
    private readonly appUrl: string,
    private readonly defs: TemplateDef[] = templates,
  ) {}

  async run(opts: { create: boolean }): Promise<SyncReport> {
    const report: SyncReport = { created: [], statuses: [], errors: [] };
    const remote = new Map<string, RemoteTemplate>();
    for (const t of await this.wa.templates.list()) remote.set(key(t.name, t.language), t);

    for (const def of this.defs)
      for (const lang of LANGS) {
        const hash = contentHash(def, lang);
        const [local] = await this.db
          .select()
          .from(stored)
          .where(and(eq(stored.name, def.name), eq(stored.language, lang)));
        if (local && local.contentHash !== hash) {
          report.errors.push(
            `${def.name} (${lang}) changed since it was sent for review: bump the version (${def.name.replace(/_v(\d+)$/, (_, n) => `_v${Number(n) + 1}`)})`,
          );
          continue;
        }
        let found = remote.get(key(def.name, lang));
        if (!found && opts.create) {
          const { id } = await this.wa.templates.create(toTemplateSpec(def, lang, this.appUrl));
          report.created.push(key(def.name, lang));
          found = { id, name: def.name, language: lang, status: 'PENDING', category: def.category };
        }
        if (!found) continue;
        await this.record(def, lang, hash, found);
        report.statuses.push({
          template: key(def.name, lang),
          status: found.status,
          ...(found.rejectedReason ? { reason: found.rejectedReason } : {}),
        });
      }
    return report;
  }

  private async record(def: TemplateDef, lang: Lang, hash: string, t: RemoteTemplate) {
    await this.db
      .insert(stored)
      .values({
        name: def.name,
        language: lang,
        category: def.category,
        contentHash: hash,
        status: t.status,
        providerId: t.id,
        rejectedReason: t.rejectedReason ?? null,
      })
      .onConflictDoUpdate({
        target: [stored.name, stored.language],
        set: {
          status: t.status,
          providerId: t.id,
          rejectedReason: t.rejectedReason ?? null,
          syncedAt: new Date(),
        },
      });
  }

  /** Is it approved in this language? (What notify() checks before every send.) */
  async approved(name: string, lang: string): Promise<boolean> {
    const [row] = await this.db
      .select({ status: stored.status })
      .from(stored)
      .where(and(eq(stored.name, name), eq(stored.language, lang)));
    return row?.status === 'APPROVED';
  }

  /**
   * The release check: every template a notification uses is approved, in English at least
   * (other languages fall back to it). Returns what is not.
   */
  async check(): Promise<string[]> {
    const problems: string[] = [];
    const used = new Set(notifications.map((n) => n.whatsapp.template.name));
    for (const name of used)
      if (!(await this.approved(name, 'en'))) problems.push(`${name} is not approved in English`);
    return problems;
  }
}
