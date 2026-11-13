import { ModelPolicy } from '@hykr/contracts';
import { RequestContext } from '@mastra/core/request-context';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelNotChosen, turnModel, versionModel } from '../assistant.js';
import { agentVersion } from '../version.js';
import { ModelConfigError, parseProviders, providersFrom } from './config.js';
import { embedText } from './fake-embedding.js';
import { chooseModel, policyProblems } from './policy.js';
import { costOf, modelRegistry, UnknownModel } from './registry.js';

const PRICE = { currency: 'XXX', inputPerMillion: 150, outputPerMillion: 600 };

const PROVIDERS = [
  {
    id: 'gw',
    baseUrl: 'https://gateway.test/v1',
    apiKeyEnv: 'GW_KEY',
    region: 'north',
    models: [
      { id: 'large', label: 'Large', price: PRICE },
      { id: 'org/small' },
      { id: 'embed', kind: 'embedding' },
    ],
  },
  {
    id: 'far',
    baseUrl: 'http://far.test/v1',
    region: 'south',
    models: [{ id: 'large' }],
  },
];

const env = (extra: Record<string, string | undefined> = {}) => ({
  MODEL_MODE: 'live',
  MODEL_PROVIDERS: JSON.stringify(PROVIDERS),
  GW_KEY: 'secret',
  ...extra,
});

const policy = (p: object = {}) => ModelPolicy.parse(p);

describe('MODEL_PROVIDERS', () => {
  it('unset or blank is no provider', () => {
    expect(parseProviders(undefined)).toEqual([]);
    expect(parseProviders('  ')).toEqual([]);
  });

  it('parses providers, their models and prices, defaulting a model to chat', () => {
    const [gw] = parseProviders(JSON.stringify(PROVIDERS));
    expect(gw.id).toBe('gw');
    expect(gw.models.map((m) => [m.id, m.kind])).toEqual([
      ['large', 'chat'],
      ['org/small', 'chat'],
      ['embed', 'embedding'],
    ]);
    expect(gw.models[0].price).toEqual(PRICE);
  });

  it('refuses bad JSON, bad fields, duplicates and the reserved provider, listing each', () => {
    expect(() => parseProviders('{')).toThrow(ModelConfigError);
    const bad = [
      { id: 'Gw', baseUrl: 'ftp://x', models: [] },
      { id: 'ok', baseUrl: 'https://x.test', apiKey: 'a', apiKeyEnv: 'B', models: [{ id: 'm' }] },
    ];
    const error = (() => {
      try {
        parseProviders(JSON.stringify(bad));
      } catch (e) {
        return e as ModelConfigError;
      }
    })();
    expect(error?.problems.length).toBeGreaterThanOrEqual(3);
    const twice = [
      { id: 'gw', baseUrl: 'https://x.test', models: [{ id: 'm' }, { id: 'm' }] },
      { id: 'gw', baseUrl: 'https://y.test', models: [{ id: 'n' }] },
      { id: 'fake', baseUrl: 'https://z.test', models: [{ id: 'o' }] },
    ];
    expect(() => parseProviders(JSON.stringify(twice))).toThrow(
      /gw\/m is listed twice[\s\S]*provider "gw" is listed twice[\s\S]*"fake" is reserved/,
    );
    const priced = [
      {
        id: 'gw',
        baseUrl: 'https://x.test',
        models: [{ id: 'm', price: { currency: 'xx', inputPerMillion: -1 } }],
      },
    ];
    expect(() => parseProviders(JSON.stringify(priced))).toThrow(ModelConfigError);
    // A price in a code that names no currency is refused at start, not priced with a guess.
    const madeUp = [
      {
        id: 'gw',
        baseUrl: 'https://x.test',
        models: [{ id: 'm', price: { currency: 'ABC', inputPerMillion: 1 } }],
      },
    ];
    expect(() => parseProviders(JSON.stringify(madeUp))).toThrow(/"ABC" is not a currency/);
  });

  it('adds OpenRouter in development, with the models AGENT_MODEL and OPENROUTER_MODELS name', () => {
    const providers = providersFrom({
      OPENROUTER_API_KEY: 'or-key',
      AGENT_MODEL: 'openrouter/lab/model-a',
      OPENROUTER_MODELS: 'lab/model-b, lab/model-a',
      EMBEDDING_MODEL: 'openrouter/lab/embed',
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'or-key',
    });
    expect(providers[0].models).toEqual([
      { id: 'lab/model-a', kind: 'chat' },
      { id: 'lab/model-b', kind: 'chat' },
      { id: 'lab/embed', kind: 'embedding' },
    ]);
    // Declared in MODEL_PROVIDERS, it is taken as declared.
    const declared = providersFrom({
      OPENROUTER_API_KEY: 'or-key',
      MODEL_PROVIDERS: JSON.stringify([
        { id: 'openrouter', baseUrl: 'https://or.test/v1', models: [{ id: 'x/y' }] },
      ]),
    });
    expect(declared.map((p) => p.baseUrl)).toEqual(['https://or.test/v1']);
    // No key: no OpenRouter.
    expect(providersFrom({ AGENT_MODEL: 'openrouter/lab/model-a' })).toEqual([]);
  });
});

describe('the registry', () => {
  it('is closed: refs, regions, prices, and defaults from the environment or the first listed', () => {
    const r = modelRegistry(env());
    expect(r.models.map((m) => m.ref)).toEqual([
      'gw/large',
      'gw/org/small',
      'gw/embed',
      'far/large',
    ]);
    expect(r.get('gw/org/small')).toMatchObject({
      provider: 'gw',
      id: 'org/small',
      region: 'north',
    });
    expect(r.defaults).toEqual({ chat: 'gw/large', embedding: 'gw/embed' });
    expect(r.problems).toEqual([]);
    expect(modelRegistry(env({ AGENT_MODEL: 'far/large' })).defaults.chat).toBe('far/large');
    expect(r.providers).toEqual([
      { id: 'gw', baseUrl: 'https://gateway.test/v1', region: 'north' },
      { id: 'far', baseUrl: 'http://far.test/v1', region: 'south' },
    ]);
  });

  it('builds models through the OpenAI-compatible provider, and refuses any other', () => {
    const r = modelRegistry(env());
    const model = r.languageModel('gw/org/small');
    expect(model.modelId).toBe('org/small');
    expect(model.provider).toContain('gw');
    expect(r.embeddingModel('gw/embed').modelId).toBe('embed');
    expect(() => r.languageModel('gw/embed')).toThrow(UnknownModel);
    expect(() => r.languageModel('openrouter/lab/x')).toThrow(UnknownModel);
    expect(() => r.embeddingModel('gw/large')).toThrow(UnknownModel);
  });

  it('warns about a default it does not have and a key variable that is empty', () => {
    const r = modelRegistry(env({ AGENT_MODEL: 'gw/missing', GW_KEY: '' }));
    expect(r.problems).toEqual([
      'The default chat model gw/missing is not a chat model of this deployment',
      'GW_KEY is empty: provider gw gets no key',
    ]);
  });

  it('fake mode: the scripted model and the hashing embedding are the defaults, whatever AGENT_MODEL says', () => {
    const r = modelRegistry(env({ MODEL_MODE: 'fake', AGENT_MODEL: 'gw/large' }));
    expect(r.defaults).toEqual({ chat: 'fake/scripted', embedding: 'fake/embedding' });
    expect(r.get('fake/scripted')?.kind).toBe('chat');
    expect(r.providers.map((p) => p.id)).toEqual(['gw', 'far']);
    expect(r.embeddingModel('fake/embedding').modelId).toBe('embedding');
  });

  it('is rebuilt when a variable it reads changes', () => {
    const a = modelRegistry(env());
    expect(modelRegistry(env())).toBe(a);
    expect(modelRegistry(env({ GW_KEY: 'other' }))).not.toBe(a);
  });

  it('prices a call in whole minor units, rounded up', () => {
    const r = modelRegistry(env());
    expect(costOf('gw/large', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, r)).toEqual({
      currency: 'XXX',
      minor: 750,
    });
    expect(costOf('gw/large', { inputTokens: 10 }, r)).toEqual({ currency: 'XXX', minor: 1 });
    expect(costOf('gw/large', {}, r)).toEqual({ currency: 'XXX', minor: 0 });
    expect(costOf('gw/org/small', { inputTokens: 10 }, r)).toBeUndefined();
  });
});

describe('the model policy', () => {
  const r = () => modelRegistry(env());

  it('no policy: the deployment default only', () => {
    expect(chooseModel(r(), policy(), { kind: 'chat' })).toMatchObject({
      ok: true,
      ref: 'gw/large',
    });
    expect(chooseModel(r(), policy(), { kind: 'chat', requested: 'gw/org/small' })).toMatchObject({
      ok: false,
      rule: 'model_not_allowed',
      status: 403,
    });
  });

  it("the business's own model, a requested one, and refusals: never a fallback", () => {
    const p = policy({ allowed: ['gw/large', 'gw/org/small'], chat: 'gw/org/small' });
    expect(chooseModel(r(), p, { kind: 'chat' })).toMatchObject({ ok: true, ref: 'gw/org/small' });
    expect(chooseModel(r(), p, { kind: 'chat', requested: 'gw/large' })).toMatchObject({
      ok: true,
      ref: 'gw/large',
    });
    expect(chooseModel(r(), p, { kind: 'chat', requested: 'far/large' })).toMatchObject({
      ok: false,
      rule: 'model_not_allowed',
    });
    expect(chooseModel(r(), p, { kind: 'chat', requested: 'gw/nope' })).toMatchObject({
      ok: false,
      rule: 'model_unknown',
      status: 503,
    });
    expect(chooseModel(r(), p, { kind: 'chat', requested: 'gw/embed' })).toMatchObject({
      ok: false,
      rule: 'model_unknown',
    });
  });

  it('regions: only providers that declare one of them', () => {
    const south = policy({
      allowed: ['far/large', 'gw/large'],
      chat: 'far/large',
      regions: ['south'],
    });
    expect(chooseModel(r(), south, { kind: 'chat' })).toMatchObject({ ok: true, ref: 'far/large' });
    const refused = chooseModel(r(), south, { kind: 'chat', requested: 'gw/large' });
    expect(refused).toMatchObject({ ok: false, rule: 'model_not_allowed' });
    expect(!refused.ok && refused.reason).toContain('outside');
  });

  it('a deployment without its default model: not configured', () => {
    const missing = modelRegistry(env({ AGENT_MODEL: 'gw/missing' }));
    expect(chooseModel(missing, policy(), { kind: 'chat' })).toMatchObject({
      ok: false,
      rule: 'model_not_configured',
    });
    const none = modelRegistry({ MODEL_MODE: 'live' });
    expect(chooseModel(none, policy(), { kind: 'embedding' })).toMatchObject({
      ok: false,
      rule: 'model_not_configured',
    });
  });

  it('fake models are always allowed', () => {
    const fake = modelRegistry(env({ MODEL_MODE: 'fake' }));
    const p = policy({ allowed: ['gw/large'], regions: ['south'] });
    expect(chooseModel(fake, p, { kind: 'chat' })).toMatchObject({
      ok: true,
      ref: 'fake/scripted',
    });
    expect(chooseModel(fake, p, { kind: 'embedding' })).toMatchObject({
      ok: true,
      ref: 'fake/embedding',
    });
  });

  it('problems before saving: unknown, wrong region, wrong kind, a chat model it would refuse', () => {
    expect(policyProblems(r(), policy({ allowed: ['gw/large'] }))).toEqual([]);
    expect(policyProblems(r(), policy())).toEqual([]);
    expect(policyProblems(r(), policy({ allowed: ['gw/nope'] }))).toEqual([
      'allowed: gw/nope is not a model of this deployment',
      "chat (the deployment's default): This business does not allow the model gw/large",
    ]);
    expect(policyProblems(r(), policy({ allowed: ['far/large'], regions: ['north'] }))).toContain(
      'allowed: far/large runs outside the regions north',
    );
    expect(
      policyProblems(r(), policy({ allowed: ['gw/large', 'gw/embed'], chat: 'gw/embed' })),
    ).toEqual(['chat: gw/embed is not a chat model of this deployment']);
    expect(policyProblems(r(), policy({ allowed: ['gw/large'], embedding: 'gw/embed' }))).toEqual([
      'embedding: This business does not allow the model gw/embed',
    ]);
    // An embedding model it does not name is refused when asked for, not when saved.
    expect(policyProblems(r(), policy({ allowed: ['far/large'], chat: 'far/large' }))).toEqual([]);
  });
});

describe('the turn’s model and the agent version', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const ctx = (values: Record<string, string>) => {
    const requestContext = new RequestContext();
    for (const [k, v] of Object.entries(values)) requestContext.set(k, v);
    return { requestContext };
  };

  it('the chosen model; a business turn without one throws; no business uses the default', () => {
    Object.assign(process.env, env({ AGENT_MODEL: 'gw/large' }));
    expect(turnModel(ctx({ model: 'gw/org/small', tenantId: 't1' }))).toBe('gw/org/small');
    expect(() => turnModel(ctx({ tenantId: 't1' }))).toThrow(ModelNotChosen);
    expect(versionModel(ctx({ tenantId: 't1' }))).toBe('none');
    expect(turnModel(ctx({}))).toBe('gw/large');
  });

  it('fake mode: the scripted model, whatever was chosen', () => {
    Object.assign(process.env, env({ MODEL_MODE: 'fake' }));
    expect(turnModel(ctx({ model: 'gw/large', tenantId: 't1' }))).toBe('fake/scripted');
  });

  it('the version is id + model + prompt hash: another model, another version', () => {
    const a = agentVersion('Be helpful.', 'gw/large');
    expect(a).toMatch(/^assistant@gw\/large#[0-9a-f]{8}$/);
    expect(agentVersion('Be helpful.', 'gw/org/small')).toMatch(/^assistant@gw\/org\/small#/);
    expect(agentVersion('Be helpful.', 'gw/org/small').split('#')[1]).toBe(a.split('#')[1]);
    expect(agentVersion('Be brief.', 'gw/large')).not.toBe(a);
  });
});

describe('the fake embedding', () => {
  it('is deterministic, of length 1, and close for texts that share words', () => {
    const a = embedText('Call the electrician on Monday');
    expect(embedText('Call the electrician on Monday')).toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    const near = embedText('the electrician comes Monday');
    const far = embedText('buy paint');
    expect(dot(a, near)).toBeGreaterThan(dot(a, far));
    expect(embedText('')).toEqual(new Array(256).fill(0));
  });
});
