import { randomUUID } from 'node:crypto';
import type { WriteResult } from '@hykr/contracts';
import { CORE_OPTIONS, type CoreOptions, runWrite, systemPrincipal } from '@hykr/core';
import { Inject, Injectable } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { SetFeature } from './commands.js';

/**
 * Switching a business's flag from server code (A11): any flag, the platform-managed ones
 * included, as the system principal, through the write path (audited as actor `system`). The
 * platform's operators (B19) and tests use it; a business switches its own flags over HTTP.
 */
@Injectable()
export class FeatureFlagsService {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  async set(tenantId: string, key: string, on: boolean): Promise<WriteResult> {
    const { result, events } = await runWrite(
      this.options.db,
      {
        principal: systemPrincipal({ tenantId, job: 'settings.feature' }),
        requestId: randomUUID(),
      },
      SetFeature.op(),
      { key, on },
    );
    for (const event of events) this.events.publish(event);
    return result;
  }
}
