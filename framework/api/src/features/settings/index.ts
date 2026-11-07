// A business's setup (A11): feature flags that fail closed, custom fields, white label (branding
// and verified custom domains), platform-scoped shared records and the business's own wording.
import { reserveRoutes } from '@hykr/contracts';
import {
  commandController,
  commandHandler,
  configureSharedRecords,
  customFieldsHook,
  customFieldsPlugin,
  customListSql,
  entityController,
  entityHandlers,
  sharedRecordsHook,
  sharedRecordsPlugin,
} from '@hykr/core';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { defineFeature } from '../feature.js';
import { FeatureFlagsCheck } from './check.js';
import { settingsCommandDefs } from './commands.js';
import { CustomFieldDef } from './custom-fields.entity.js';
import { customDomainsAuth } from './domains.js';
import { FeatureFlagsService } from './flags.service.js';
import { FeatureGateInterceptor } from './gate.interceptor.js';
import { FeatureGates, featureFlagsHook } from './gates.js';
import { EmailWording, SettingsChangedHandler } from './lifecycle.js';
import { SettingsController } from './settings.controller.js';
import { SettingsTurnHook } from './turn.js';

export { setTxtResolver } from './domains.js';

// /api/settings, /api/features, /api/custom-fields and /api/branding are the framework's.
reserveRoutes('settings', 'features', 'custom-fields', 'branding');

/** The business that keeps shared records: deployment configuration, never a business setting. */
@Injectable()
class SharedRecordsConfig implements OnModuleInit {
  onModuleInit() {
    configureSharedRecords({ platformTenantId: process.env.PLATFORM_TENANT_ID });
  }
}

export const settingsFeature = defineFeature({
  name: 'settings',
  controllers: [
    SettingsController,
    entityController(CustomFieldDef),
    ...settingsCommandDefs.map(commandController),
  ],
  providers: [
    FeatureGates,
    FeatureFlagsCheck,
    FeatureFlagsService,
    SharedRecordsConfig,
    SettingsTurnHook,
    EmailWording,
    SettingsChangedHandler,
    { provide: APP_INTERCEPTOR, useClass: FeatureGateInterceptor },
    ...entityHandlers(CustomFieldDef),
    ...settingsCommandDefs.map(commandHandler),
  ],
  exports: [FeatureGates, FeatureFlagsService],
  contributes: {
    entityPlugins: [customFieldsPlugin, sharedRecordsPlugin],
    writeHooks: [customFieldsHook, sharedRecordsHook, featureFlagsHook],
    listFieldSql: [customListSql],
    authPlugins: [customDomainsAuth],
  },
});
