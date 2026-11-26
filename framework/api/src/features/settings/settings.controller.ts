// Reading a business's setup (A11): what the apps need in one call, the flags with their state,
// the business's domains, and its public branding on a verified domain.
import {
  type ClientSettings,
  type FeatureState,
  featureEnabled,
  featureFlags,
  type Principal,
  type PublicBranding,
  SettingsCapability,
  type SettingsSectionView,
  type TenantDomain,
} from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  requireCapability,
  TenantConfigService,
} from '@hykr/core';
import { schema } from '@hykr/db';
import { can } from '@hykr/policy';
import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import { asc, eq } from 'drizzle-orm';
import { domainView } from './commands.js';
import { isDomainOrigin, verifiedTenantOf } from './domains.js';
import { FeatureGates, flagsOn } from './gates.js';
import { capabilityRule, sectionView, settingsTarget, settingsTargets } from './sections.js';

const list = (xs: readonly string[] | undefined) => [...(xs ?? [])];

@Controller('api')
@OptionalAuth()
export class SettingsController {
  constructor(
    private readonly config: TenantConfigService,
    private readonly gates: FeatureGates,
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
  ) {}

  /** Everything the apps need: flags on, what is off, branding, the business's phrases. */
  @Get('settings')
  @UseGuards(PrincipalGuard)
  async settings(@CurrentPrincipal() p: Principal): Promise<ClientSettings> {
    const { settings } = await this.config.get(p.tenantId ?? '');
    return {
      features: flagsOn(settings),
      off: await this.gates.off(p.tenantId),
      branding: settings.branding,
      phrases: settings.wording.phrases,
    };
  }

  /** Every declared flag, on or off here, and who may switch it. */
  @Get('features')
  @UseGuards(PrincipalGuard, HumanOnlyGuard)
  async features(@CurrentPrincipal() p: Principal): Promise<FeatureState[]> {
    const { settings } = await this.config.get(p.tenantId ?? '');
    return featureFlags.all().map((f) => ({
      key: f.key,
      label: { ...f.label },
      description: f.description ? { ...f.description } : null,
      managedBy: f.managedBy ?? 'platform',
      on: featureEnabled(settings, f.key),
      gates: {
        modules: list(f.gates?.modules),
        entities: list(f.gates?.entities),
        commands: list(f.gates?.commands),
        tools: list(f.gates?.tools),
        nav: list(f.gates?.nav),
      },
    }));
  }

  /** The business's web addresses and their TXT records (settings managers only). */
  @Get('settings/domains')
  @UseGuards(PrincipalGuard, HumanOnlyGuard)
  async domains(@CurrentPrincipal() p: Principal): Promise<TenantDomain[]> {
    requireCapability(p, SettingsCapability.name, { rule: 'needs_settings_manage' });
    const d = schema.tenantDomains;
    const rows = await this.options.db
      .select()
      .from(d)
      .where(eq(d.tenantId, p.tenantId ?? ''))
      .orderBy(asc(d.createdAt));
    return rows.map(domainView);
  }

  /**
   * The sections the generic writer changes that this person may change (`general` first), each
   * with its value (defaults applied), read fresh from the business's row.
   */
  @Get('settings/sections')
  @UseGuards(PrincipalGuard, HumanOnlyGuard)
  async sections(@CurrentPrincipal() p: Principal): Promise<SettingsSectionView[]> {
    const settings = await this.stored(p);
    return settingsTargets()
      .filter((t) => can(p, t.capability))
      .map((t) => sectionView(t, settings));
  }

  /** One of them: 404 when nothing by that name is changed here, 403 without its capability. */
  @Get('settings/sections/:section')
  @UseGuards(PrincipalGuard, HumanOnlyGuard)
  async section(
    @CurrentPrincipal() p: Principal,
    @Param('section') key: string,
  ): Promise<SettingsSectionView> {
    const target = settingsTarget(key);
    if (!target)
      throw new NotFoundException({
        error: 'not_found',
        message: `No settings section "${key}" is changed here`,
      });
    requireCapability(p, target.capability, { rule: capabilityRule(target.capability) });
    return sectionView(target, await this.stored(p));
  }

  /** The business's stored settings, as they are now (not the cached copy). */
  private async stored(p: Principal): Promise<Record<string, unknown>> {
    if (!p.tenantId) throw new NotFoundException({ error: 'not_found', message: 'No business' });
    const t = schema.tenants;
    const [row] = await this.options.db
      .select({ settings: t.settings })
      .from(t)
      .where(eq(t.id, p.tenantId));
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No business' });
    return (row.settings as Record<string, unknown> | null) ?? {};
  }

  /**
   * Branding for the sign-in screen of a verified custom domain, before anyone signs in: the
   * request's Origin (or `?origin=`). Anything else is 404, so nothing is learnt about a business.
   * No session is needed, so anything that is not an https origin is refused before any lookup.
   */
  @Get('branding/public')
  @AllowAnonymous()
  async publicBranding(
    @Headers('origin') header: string | undefined,
    @Query('origin') asked: unknown,
  ): Promise<PublicBranding> {
    const origin = asked ?? header;
    const tenantId =
      typeof origin === 'string' && isDomainOrigin(origin) ? await verifiedTenantOf(origin) : null;
    if (!tenantId) throw new NotFoundException({ error: 'not_found', message: 'Not found' });
    const { branding } = (await this.config.get(tenantId)).settings;
    return { name: branding.name, logoUrl: branding.logoUrl, colors: branding.colors };
  }
}
