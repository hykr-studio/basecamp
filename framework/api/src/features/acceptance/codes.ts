import { VerificationCode } from '@hykr/notifications';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OtpService } from '../../channels/otp/otp.service.js';
import { OtpSender } from '../../channels/otp/sender.js';
import { ACCEPTANCE_PURPOSE } from './checks.js';
import type { ChallengeMeta } from './ops.js';

const log = new Logger('Acceptance');

/**
 * Makes and sends an acceptance's code, in the worker (the `acceptance.otp` subscriber on
 * otp.requested): the code exists only here and in the message (decisions B8, 9). A retry after
 * a failed send makes a new code, as long as nobody has tried the old one.
 */
@Injectable()
export class AcceptanceCodes {
  constructor(@Inject(ModuleRef) private readonly ref: ModuleRef) {}

  async deliver(challengeId: string): Promise<'sent' | 'skipped'> {
    const otp = this.ref.get(OtpService, { strict: false });
    const sender = this.ref.get(OtpSender, { strict: false });
    const pending = await otp.get(challengeId);
    if (!pending || pending.purpose !== ACCEPTANCE_PURPOSE) return 'skipped';
    const issued = await otp.issue(challengeId, { again: true });
    if (!issued) return 'skipped';
    const { row, code } = issued;
    const meta = row.meta as unknown as ChallengeMeta;
    if (row.channel === 'whatsapp')
      await sender.whatsapp(row, code, {
        lang: meta.lang,
        template: VerificationCode,
        contactId: meta.contactId,
      });
    else if (row.channel === 'email')
      await sender.email(row, code, { lang: meta.lang, business: meta.business });
    else return 'skipped';
    log.log(`sent an acceptance code by ${row.channel}`);
    return 'sent';
  }
}
