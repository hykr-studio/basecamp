import { TenantConfigService, type TenantInfo } from '@hykr/core';
import { Injectable } from '@nestjs/common';

/**
 * The channels' handle on a business's name and settings: TenantConfigService (@hykr/core),
 * which caches them. It only delegates, so there is one cache per process. The processors that
 * inject it switch to TenantConfigService when their owners next edit them (decisions F4).
 */
@Injectable()
export class TenantsService {
  constructor(private readonly config: TenantConfigService) {}

  get(tenantId: string): Promise<TenantInfo> {
    return this.config.get(tenantId);
  }
}
