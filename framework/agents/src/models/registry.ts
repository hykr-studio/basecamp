// The deployment's models, from the environment: each provider an OpenAI-compatible API, each
// model a ref '<provider>/<model>'. Closed: a model nobody configured cannot be built.
import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import type { ModelKind, ModelPrice, Money } from '@hykr/contracts';
import {
  FAKE_CHAT,
  FAKE_EMBEDDING,
  FAKE_PROVIDER,
  type ModelEnv,
  type ProviderConfig,
  providersFrom,
} from './config.js';
import { type EmbeddingModel, fakeEmbeddingModel } from './fake-embedding.js';

export type LanguageModel = ReturnType<OpenAICompatibleProvider['chatModel']>;
export type { EmbeddingModel };

/** One model the deployment offers. */
export interface ModelEntry {
  /** '<provider>/<model>': what policies, hooks and audit rows name. */
  ref: string;
  provider: string;
  /** The provider's own id, as sent in its requests. */
  id: string;
  kind: ModelKind;
  label?: string;
  /** Its provider's region, if it declares one. */
  region?: string;
  price?: ModelPrice;
}

/** A provider as callers may see it: never its key. */
export interface ProviderEntry {
  id: string;
  baseUrl: string;
  region?: string;
}

/** A model ref the registry cannot build: not configured, or not of that kind. */
export class UnknownModel extends Error {
  constructor(
    readonly ref: string,
    readonly kind: ModelKind,
  ) {
    super(`${ref} is not a ${kind} model of this deployment (MODEL_PROVIDERS)`);
    this.name = 'UnknownModel';
  }
}

export interface ModelRegistry {
  providers: readonly ProviderEntry[];
  models: readonly ModelEntry[];
  /** What a turn uses when nothing names a model. May name a model that is not registered. */
  defaults: { chat?: string; embedding?: string };
  /** Warnings for the logs: a default that is not registered, a key variable that is empty. */
  problems: readonly string[];
  get(ref: string): ModelEntry | undefined;
  /** The chat model, built on the AI SDK's OpenAI-compatible provider. Throws UnknownModel. */
  languageModel(ref: string): LanguageModel;
  /** The embedding model. Throws UnknownModel. */
  embeddingModel(ref: string): EmbeddingModel;
}

function build(env: ModelEnv, configs: ProviderConfig[]): ModelRegistry {
  const fake = env.MODEL_MODE === 'fake';
  const problems: string[] = [];
  const models: ModelEntry[] = configs.flatMap((p) =>
    p.models.map((m) => ({
      ref: `${p.id}/${m.id}`,
      provider: p.id,
      id: m.id,
      kind: m.kind,
      ...(m.label ? { label: m.label } : {}),
      ...(p.region ? { region: p.region } : {}),
      ...(m.price ? { price: m.price } : {}),
    })),
  );
  const byRef = new Map(models.map((m) => [m.ref, m]));
  const first = (kind: ModelKind) =>
    models.find((m) => m.kind === kind && m.provider !== FAKE_PROVIDER)?.ref;
  // Fake mode: the scripted model and the hashing embedding, whatever AGENT_MODEL says.
  const defaults = fake
    ? { chat: FAKE_CHAT, embedding: FAKE_EMBEDDING }
    : {
        chat: env.AGENT_MODEL?.trim() || first('chat'),
        embedding: env.EMBEDDING_MODEL?.trim() || first('embedding'),
      };
  for (const [kind, ref] of Object.entries(defaults))
    if (ref && byRef.get(ref)?.kind !== kind)
      problems.push(`The default ${kind} model ${ref} is not a ${kind} model of this deployment`);

  const apis = new Map<string, OpenAICompatibleProvider>();
  const api = (id: string) => {
    let provider = apis.get(id);
    if (provider) return provider;
    const p = configs.find((c) => c.id === id);
    if (!p) throw new Error(`No provider ${id}`);
    const apiKey = p.apiKey ?? (p.apiKeyEnv ? env[p.apiKeyEnv] : undefined);
    provider = createOpenAICompatible({
      name: p.id,
      baseURL: p.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(p.headers ? { headers: p.headers } : {}),
      // Token counts on streamed replies too: what credits and caps are metered on.
      includeUsage: true,
    });
    apis.set(id, provider);
    return provider;
  };
  for (const p of configs)
    if (p.apiKeyEnv && !env[p.apiKeyEnv])
      problems.push(`${p.apiKeyEnv} is empty: provider ${p.id} gets no key`);

  const entry = (ref: string, kind: ModelKind) => {
    const m = byRef.get(ref);
    if (!m || m.kind !== kind) throw new UnknownModel(ref, kind);
    return m;
  };
  return {
    providers: configs
      .filter((p) => p.id !== FAKE_PROVIDER)
      .map((p) => ({ id: p.id, baseUrl: p.baseUrl, ...(p.region ? { region: p.region } : {}) })),
    models,
    defaults,
    problems,
    get: (ref) => byRef.get(ref),
    languageModel(ref) {
      const m = entry(ref, 'chat');
      // The scripted model is built by the assistant from the application's scripts.
      if (m.provider === FAKE_PROVIDER) throw new UnknownModel(ref, 'chat');
      return api(m.provider).chatModel(m.id);
    },
    embeddingModel(ref) {
      const m = entry(ref, 'embedding');
      if (m.provider === FAKE_PROVIDER) return fakeEmbeddingModel(m.id);
      return api(m.provider).embeddingModel(m.id);
    },
  };
}

const READS = [
  'MODEL_MODE',
  'MODEL_PROVIDERS',
  'AGENT_MODEL',
  'EMBEDDING_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_MODELS',
] as const;

let cached: { key: string; keyVars: string[]; keys: string; registry: ModelRegistry } | undefined;

/**
 * The deployment's registry, from this process's environment, built once and again only when a
 * variable it reads changes (tests switch it). Malformed MODEL_PROVIDERS throws ModelConfigError.
 */
export function modelRegistry(env: ModelEnv = process.env): ModelRegistry {
  const key = JSON.stringify(READS.map((k) => env[k] ?? null));
  if (
    cached?.key === key &&
    cached.keys === JSON.stringify(cached.keyVars.map((k) => env[k] ?? null))
  )
    return cached.registry;
  const configs = providersFrom(env);
  const keyVars = configs.flatMap((p) => (p.apiKeyEnv ? [p.apiKeyEnv] : []));
  const registry = build(env, configs);
  cached = { key, keyVars, keys: JSON.stringify(keyVars.map((k) => env[k] ?? null)), registry };
  return registry;
}

/** What a model costs the deployment per million tokens, if the deployment priced it. */
export function priceOf(ref: string, registry = modelRegistry()): ModelPrice | undefined {
  return registry.get(ref)?.price;
}

/** Tokens one call used, as the AI SDK reports them. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * What one call cost the deployment, in whole minor units (rounded up, so a cap is reached early
 * rather than late). Undefined when the model has no price.
 */
export function costOf(
  ref: string,
  usage: TokenUsage,
  registry = modelRegistry(),
): Money | undefined {
  const price = priceOf(ref, registry);
  if (!price) return undefined;
  const exact =
    ((usage.inputTokens ?? 0) * price.inputPerMillion +
      (usage.outputTokens ?? 0) * (price.outputPerMillion ?? 0)) /
    1_000_000;
  // A hair below the next unit is float noise (0.1 * 3), not a fraction of a unit.
  return { currency: price.currency, minor: Math.max(0, Math.ceil(exact - 1e-9)) };
}
