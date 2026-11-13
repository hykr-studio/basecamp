import type {
  AcceptanceInfo,
  AcceptanceKindInfo,
  AcceptanceStatus,
  Principal,
} from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  entityDef,
  runWrite,
  systemPrincipal,
  tenantOf,
} from '@hykr/core';
import { acceptances, type Database, otpChallenges, writeAudit } from '@hykr/db';
import { type Lang, langOf } from '@hykr/i18n';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus } from '@nestjs/cqrs';
import { and, desc, eq, sql } from 'drizzle-orm';
import { OtpService } from '../../channels/otp/otp.service.js';
import { documents as documentDefs } from '../documents/define.js';
import {
  acceptedBefore,
  decide,
  ESIGN_PURPOSE,
  resolveFor,
  shownAddresses,
  signerOf,
  statementOf,
} from './checks.js';
import { acceptances as acceptanceDefs, channelsOfAcceptance } from './define.js';
import type { ESignResult } from './esign.js';
import { type EvidenceRow, presentEvidence, verifyChain, verifyRow } from './evidence.js';
import { signedOp } from './ops.js';

const noSuch = () => new NotFoundException({ error: 'not_found', message: 'No such acceptance' });

/**
 * Reading acceptances (through the record they are about, as each reader may see them),
 * checking their chain, and recording what an e-sign provider reports. Asking for a code and
 * accepting are write operations (ops.ts), served by the controller. Nothing here reads the
 * configuration, so `@hykr/api`'s entry can export it.
 */
@Injectable()
export class AcceptanceService {
  private readonly db: Database;

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {
    this.db = core.db;
  }

  private get otp(): OtpService {
    return this.ref.get(OtpService, { strict: false });
  }

  /** The acceptances an entity's records have (every one without an entity). */
  kinds(entity?: string): AcceptanceKindInfo[] {
    return acceptanceDefs
      .all()
      .map((def) => ({ def, doc: documentDefs.get(def.document) }))
      .filter(({ doc }) => doc && (!entity || doc.entity === entity))
      .map(({ def, doc }) => ({
        name: def.name,
        document: def.document,
        entity: doc?.entity ?? '',
        label: def.label,
        channels: channelsOfAcceptance(def),
        esign: def.esign ?? null,
      }));
  }

  /**
   * One PDF's acceptance for the person looking at it: what they would agree to, where a code
   * would go (masked), whether they may (and why not), and the record's acceptances they see.
   */
  async status(p: Principal, documentId: string, lang?: Lang): Promise<AcceptanceStatus> {
    const r = await resolveFor(this.db, p, documentId);
    const signer = await signerOf(this.db, p);
    const prior = signer ? await acceptedBefore(this.db, tenantOf(p), r.doc.id, signer) : false;
    const decision = decide(p, r, { prior, signer });
    const shown = langOf(lang ?? r.doc.lang);
    return {
      acceptance: r.def.name,
      label: r.def.label,
      document: {
        id: r.doc.id,
        name: r.doc.fileName,
        version: r.doc.version,
        sha256: r.doc.sha256,
        status: r.doc.status,
      },
      statement: r.doc.status === 'ready' ? statementOf(r, shown) : '',
      lang: shown,
      channels: decision.decision === 'allow' ? shownAddresses(r.def, signer) : [],
      esign: r.def.esign ?? null,
      can:
        decision.decision === 'allow'
          ? { ok: true }
          : { ok: false, rule: decision.rule, reason: decision.reason },
      accepted: await this.rowsOf(p, r.entity.name, r.doc.resourceId),
    };
  }

  /** A record's acceptances, newest first, for whoever reaches the record now (404 otherwise). */
  async list(p: Principal, entity: string, id: string): Promise<AcceptanceInfo[]> {
    const def = entityDef(entity);
    if (!def || !p.tenantId || !(await def.repo.find(this.db, p, id))) throw noSuch();
    return this.rowsOf(p, def.name, id);
  }

  private async rowsOf(p: Principal, entity: string, id: string): Promise<AcceptanceInfo[]> {
    const rows = await this.db
      .select()
      .from(acceptances)
      .where(
        and(
          eq(acceptances.tenantId, tenantOf(p)),
          eq(acceptances.resourceType, entity),
          eq(acceptances.resourceId, id),
        ),
      )
      .orderBy(desc(acceptances.seq));
    return rows.map((row) => presentEvidence(row, p));
  }

  /** One acceptance, and whether it still matches its hash and the row before it. */
  async get(p: Principal, id: string): Promise<AcceptanceInfo> {
    const [row] = await this.db
      .select()
      .from(acceptances)
      .where(and(eq(acceptances.id, id), eq(acceptances.tenantId, p.tenantId ?? '')));
    if (!row || !(await this.reaches(p, row))) throw noSuch();
    return presentEvidence(row, p, { verified: await verifyRow(this.db, row) });
  }

  private async reaches(p: Principal, row: EvidenceRow): Promise<boolean> {
    const def = entityDef(row.resourceType);
    return !!def && !!(await def.repo.find(this.db, p, row.resourceId));
  }

  /** Every acceptance of a business, checked in order: each matches its hash, none is missing. */
  verifyChain(tenantId: string) {
    return verifyChain(this.db, tenantId);
  }

  /**
   * What an e-sign provider reported, from its verified webhook (a connector handler): a signing
   * this business started at that provider. Signed: the evidence is recorded (method 'esign'),
   * and the record moves, as the business's system principal after the same checks as a code;
   * anything else ends the signing. Returns the evidence, or null when it was not signed.
   */
  async completeESign(result: ESignResult): Promise<AcceptanceInfo | null> {
    const [ch] = await this.db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.purpose, ESIGN_PURPOSE),
          eq(otpChallenges.channel, 'esign'),
          eq(otpChallenges.address, result.provider),
          sql`${otpChallenges.meta}->>'ref' = ${result.ref}`,
        ),
      );
    if (!ch) throw new NotFoundException({ error: 'not_found', message: 'No such signing' });
    const p = systemPrincipal({ tenantId: ch.tenantId, job: 'acceptance.esign' });
    if (result.status !== 'signed') {
      await this.otp.consume(this.db, ch.id);
      await writeAudit(this.db, {
        action: 'acceptance.signed',
        resourceType: 'otpChallenge',
        resourceId: ch.id,
        actorKind: 'system',
        actorId: 'acceptance.esign',
        tenantId: ch.tenantId,
        channel: 'background',
        outcome: 'denied',
        rule: `esign_${result.status}`,
        reason: `The provider reports the signing ${result.status}`,
      });
      return null;
    }
    const { result: out, events } = await runWrite(
      this.db,
      { principal: p, requestId: `esign-${ch.id}` },
      signedOp(this.otp, ch, result),
      {},
    );
    for (const event of events) this.events.publish(event);
    return out.status === 'done' ? (out.value as AcceptanceInfo) : null;
  }
}
