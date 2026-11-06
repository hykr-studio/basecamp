// Keeping a business's settings fresh in this process (A11), and the business's own email wording.
import { TenantConfigService } from '@hykr/core';
import { setEmailWording } from '@hykr/notifications';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { EventsHandler, type IEventHandler } from '@nestjs/cqrs';
import { SettingsChanged } from './commands.js';
import { forgetOrigin } from './domains.js';

/** After a settings write commits, this process drops its copy (others within their TTL). */
@EventsHandler(SettingsChanged)
export class SettingsChangedHandler implements IEventHandler<SettingsChanged> {
  constructor(private readonly config: TenantConfigService) {}

  handle(event: SettingsChanged) {
    this.config.invalidate(event.tenantId);
    if (event.origin) forgetOrigin(event.origin);
  }
}

/**
 * A notification's email in the business's own words (`wording.notifications[key].email`), when
 * it has them: read from the settings the dispatcher has just loaded (the cache), never a query.
 */
@Injectable()
export class EmailWording implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly config: TenantConfigService) {}

  onModuleInit() {
    setEmailWording(({ tenantId, key, part, lang }) => {
      const email = this.config.peek(tenantId)?.settings.wording.notifications[key]?.email;
      return email?.[part]?.[lang] ?? email?.[part]?.en;
    });
  }

  onModuleDestroy() {
    setEmailWording(undefined);
  }
}
