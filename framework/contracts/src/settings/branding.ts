// White label (A11): how a business's app looks, and the web addresses it is served on. Empty
// values mean the framework's own theme.
import { z } from 'zod';
import { defineSettingsSection } from './sections.js';

declare module './sections.js' {
  interface TenantSettingsSections {
    branding: Branding;
  }
}

/** A colour as six hex digits: '#1f6feb'. */
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour is #rrggbb');

/** An https address (http only for localhost, in development). */
export const HttpsUrl = z
  .url()
  .max(500)
  .refine(
    (u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u),
    'Use an https address',
  );

/** The colours a business may set: the app's accent, the text on it, and the rail. */
export const BrandColors = z.object({
  primary: HexColor.nullable().default(null),
  primaryText: HexColor.nullable().default(null),
  rail: HexColor.nullable().default(null),
});

export const Branding = z
  .object({
    /** The name the app shows instead of the product's. */
    name: z.string().trim().min(1).max(60).nullable().default(null),
    /** A logo, as an https address. */
    logoUrl: HttpsUrl.nullable().default(null),
    colors: BrandColors.default({ primary: null, primaryText: null, rail: null }),
  })
  .default({ name: null, logoUrl: null, colors: { primary: null, primaryText: null, rail: null } });
export type Branding = z.infer<typeof Branding>;

export const BrandingSection = defineSettingsSection('branding', Branding);

/** A change to the branding: only the fields sent change; null clears one. */
export const BrandingPatch = z
  .object({
    name: z.string().trim().min(1).max(60).nullable().optional(),
    logoUrl: HttpsUrl.nullable().optional(),
    colors: z
      .object({
        primary: HexColor.nullable().optional(),
        primaryText: HexColor.nullable().optional(),
        rail: HexColor.nullable().optional(),
      })
      .optional(),
  })
  .strict();
export type BrandingPatch = z.infer<typeof BrandingPatch>;

/** What anyone may read about a business on its own verified address, before signing in. */
export const PublicBranding = z.object({
  name: z.string().nullable(),
  logoUrl: z.string().nullable(),
  colors: BrandColors,
});
export type PublicBranding = z.infer<typeof PublicBranding>;

/** A web address of a business: an exact https origin, never a path or a wildcard. */
export const DomainOrigin = z
  .string()
  .max(200)
  .regex(/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/, {
    message: 'Give an exact https origin, such as https://app.example.com',
  });

/** A custom domain as its business sees it. */
export const TenantDomain = z.object({
  id: z.string(),
  origin: z.string(),
  /** Publish this TXT record, then verify. */
  record: z.object({ name: z.string(), value: z.string() }),
  verified: z.boolean(),
  verifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type TenantDomain = z.infer<typeof TenantDomain>;

/** The TXT record that proves a business controls a host. */
export const domainRecordName = (origin: string) => `_basecamp-verify.${new URL(origin).hostname}`;
