import { z } from 'zod';
import { CurrencyCode } from '../framework/money.js';
import { defineCapability } from '../roles.js';
import { defineSettingsSection } from './sections.js';

/**
 * A model in the deployment's registry: `<provider id>/<model id>` ('gateway/large'). The
 * provider id is lower case; the model id is the provider's own and may contain '/'.
 */
export const ModelRef = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9-]*\/\S+$/, 'A model ref: "<provider>/<model>"');
export type ModelRef = z.infer<typeof ModelRef>;

/** A region as a deployment's providers declare it: lower case letters, digits and "-". */
export const ModelRegion = z
  .string()
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'A region: lower case letters, digits and "-"');

/** What a model is for: the assistant's turns, or embeddings (memory recall). */
export const ModelKind = z.enum(['chat', 'embedding']);
export type ModelKind = z.infer<typeof ModelKind>;

/**
 * What a model costs the deployment: minor units of `currency` (ISO 4217) per million tokens.
 * Rates may be fractional: a gateway charges fractions of a minor unit per token.
 */
export const ModelPrice = z
  .object({
    currency: CurrencyCode,
    inputPerMillion: z.number().finite().min(0),
    outputPerMillion: z.number().finite().min(0).optional(),
  })
  .strict();
export type ModelPrice = z.infer<typeof ModelPrice>;

/** The policy's fields, as `PUT /api/models/policy` takes them (unknown keys are refused). */
export const ModelPolicyFields = z.object({
  /** Model refs this business may use. Empty: the deployment's defaults only. */
  allowed: z.array(ModelRef).max(50).default([]),
  /** The chat model when nothing names one. Default: the deployment's. */
  chat: ModelRef.optional(),
  /** The embedding model (memory recall). Default: the deployment's. */
  embedding: ModelRef.optional(),
  /** Only providers in these regions. Empty: any region. */
  regions: z.array(ModelRegion).max(20).default([]),
});

/**
 * Which models a business's assistant may use, from those the deployment configures. It fails
 * closed: with `allowed` empty, only the deployment's default models; with it, exactly those.
 * With `regions`, a model's provider must declare one of them.
 */
export const ModelPolicy = ModelPolicyFields.prefault({});
export type ModelPolicy = z.infer<typeof ModelPolicy>;

declare module './sections.js' {
  interface TenantSettingsSections {
    models: ModelPolicy;
  }
}

export const ModelsSettings = defineSettingsSection('models', ModelPolicy);

/** Set the business's model policy (PUT /api/models/policy) and see what models cost. */
export const ModelsCapability = defineCapability({
  name: 'models.manage',
  label: {
    en: "Choose the assistant's models",
    hi: 'असिस्टेंट के मॉडल चुनें',
    te: 'అసిస్టెంట్ మోడల్‌లను ఎంచుకోండి',
  },
  roles: ['owner', 'admin'],
});

/** Which model a turn (or an embedding) would use for this business, or why none may run. */
export type ModelUse = { ref: string } | { refused: { rule: string; reason: string } };

/** One model of the deployment, as `GET /api/models` shows it to a business. */
export interface ModelInfo {
  ref: string;
  kind: ModelKind;
  label?: string;
  region?: string;
  /** This business's policy lets it use the model. */
  allowed: boolean;
  /** Only for people with `models.manage`. */
  price?: ModelPrice;
}

/** `GET /api/models`: the business's policy, what it would use, and the deployment's models. */
export interface ModelsOverview {
  policy: ModelPolicy;
  chat: ModelUse;
  /** Null when the deployment configures no embedding model. */
  embedding: ModelUse | null;
  models: ModelInfo[];
}
