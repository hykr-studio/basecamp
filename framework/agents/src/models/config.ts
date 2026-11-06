// The deployment's model registry as configured: MODEL_PROVIDERS (JSON), plus OpenRouter in
// development. Parsed and checked here; registry.ts builds the providers.
import { ModelKind, ModelPrice, ModelRef, ModelRegion } from '@hykr/contracts';
import { z } from 'zod';

/** The in-process provider of fake mode: the scripted model and a word-hashing embedding. */
export const FAKE_PROVIDER = 'fake';
export const FAKE_CHAT = 'fake/scripted';
export const FAKE_EMBEDDING = 'fake/embedding';

export const OPENROUTER = 'openrouter';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

const ModelConfig = z
  .object({
    /** The provider's own id for it, as sent in requests ('large', 'org/model-70b'). */
    id: z.string().min(1).max(160).regex(/^\S+$/, 'no spaces'),
    kind: ModelKind.default('chat'),
    label: z.string().min(1).max(80).optional(),
    price: ModelPrice.optional(),
  })
  .strict();

const ProviderConfig = z
  .object({
    /** The first part of its models' refs: lower case letters, digits and "-". */
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'lower case letters, digits and "-"'),
    /** The OpenAI-compatible API's base URL ('https://gateway.example/v1'). */
    baseUrl: z.url({ protocol: /^https?$/ }),
    /** The environment variable that holds the key (preferred: keeps it out of this JSON). */
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/, 'an environment variable name')
      .optional(),
    apiKey: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Where it runs, as the deployment names it: a business's `regions` match on it. */
    region: ModelRegion.optional(),
    models: z.array(ModelConfig).min(1),
  })
  .strict()
  .refine((p) => !(p.apiKey && p.apiKeyEnv), 'give apiKey or apiKeyEnv, not both');

export type ProviderConfig = z.infer<typeof ProviderConfig>;

/** MODEL_PROVIDERS is malformed: every problem, so one deploy fixes them all. */
export class ModelConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`MODEL_PROVIDERS is not valid:\n- ${problems.join('\n- ')}`);
    this.name = 'ModelConfigError';
  }
}

/** The environment variables the registry reads. */
export type ModelEnv = Readonly<Record<string, string | undefined>>;

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** MODEL_PROVIDERS as providers, checked. Unset or blank: none. */
export function parseProviders(raw: string | undefined): ProviderConfig[] {
  if (!raw?.trim()) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ModelConfigError([`not JSON: ${e instanceof Error ? e.message : e}`]);
  }
  const parsed = z.array(ProviderConfig).safeParse(json);
  if (!parsed.success)
    throw new ModelConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const p of parsed.data) {
    if (p.id === FAKE_PROVIDER) problems.push(`provider "${FAKE_PROVIDER}" is reserved`);
    if (ids.has(p.id)) problems.push(`provider "${p.id}" is listed twice`);
    ids.add(p.id);
    const refs = new Set<string>();
    for (const m of p.models) {
      const ref = `${p.id}/${m.id}`;
      if (!ModelRef.safeParse(ref).success) problems.push(`${ref}: not a valid model ref`);
      if (refs.has(ref)) problems.push(`${ref} is listed twice`);
      refs.add(ref);
    }
  }
  if (problems.length) throw new ModelConfigError(problems);
  return parsed.data;
}

/** The model id of a ref under this provider, if it is one of its refs. */
const under = (provider: string, ref: string | undefined) =>
  ref?.startsWith(`${provider}/`) ? ref.slice(provider.length + 1) : undefined;

/**
 * Every provider this deployment configures: MODEL_PROVIDERS, then OpenRouter in development
 * (OPENROUTER_API_KEY, when MODEL_PROVIDERS does not declare `openrouter` itself), then the
 * in-process `fake` provider in fake mode.
 */
export function providersFrom(env: ModelEnv): ProviderConfig[] {
  const providers = parseProviders(env.MODEL_PROVIDERS);
  const key = env.OPENROUTER_API_KEY?.trim();
  if (key && !providers.some((p) => p.id === OPENROUTER)) {
    const chat = [under(OPENROUTER, env.AGENT_MODEL), ...list(env.OPENROUTER_MODELS)];
    const embedding = under(OPENROUTER, env.EMBEDDING_MODEL);
    const models = [
      ...[...new Set(chat.filter((m): m is string => !!m))].map((id) => ({
        id,
        kind: 'chat' as const,
      })),
      ...(embedding ? [{ id: embedding, kind: 'embedding' as const }] : []),
    ];
    if (models.length)
      providers.push({
        id: OPENROUTER,
        baseUrl: env.OPENROUTER_BASE_URL || OPENROUTER_URL,
        apiKey: key,
        models,
      });
  }
  if (env.MODEL_MODE === 'fake')
    providers.push({
      id: FAKE_PROVIDER,
      baseUrl: 'http://localhost/fake',
      models: [
        { id: 'scripted', kind: 'chat', label: 'Scripted model' },
        { id: 'embedding', kind: 'embedding', label: 'Word-hashing embedding' },
      ],
    });
  return providers;
}
