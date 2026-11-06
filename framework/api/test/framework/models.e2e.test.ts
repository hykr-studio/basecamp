// The model gateway and each business's model policy (A10): the deployment's models from
// MODEL_PROVIDERS (here a stub OpenAI-compatible gateway in this process), GET /api/models and
// PUT /api/models/policy through the write path, every turn's model chosen and checked by the
// policy (a hook's too), the agent version naming the turn's model, the guardrail and embeddings
// on the business's models, and nothing ever falling back to another model.
import { costOf, modelRegistry } from '@hykr/agents';
import { TenantConfigService } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelPolicyService, ModelRefused } from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { type StubGateway, startGateway } from '../fixture/dist/features/models/gateway.js';
import { BIG_MODEL, modelsApp, seen } from '../fixture/dist/features/models/index.js';

const ana = new Person('Ana Models');
const sam = new Person('Sam Models');
const ravi = new Person('Ravi Models');
let anaTenant = '';
let raviTenant = '';
let gateway: StubGateway;

const ENV = [
  'MODEL_MODE',
  'MODEL_PROVIDERS',
  'AGENT_MODEL',
  'EMBEDDING_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODELS',
  'FIXTURE_GATEWAY_KEY',
  'GUARDRAILS',
] as const;
const saved = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));

const PRICE = { currency: 'XXX', inputPerMillion: 1000, outputPerMillion: 4000 };

/** Two providers on the stub: "stub" in region north (key from a variable), "far" in south. */
const providers = (url: string) => [
  {
    id: 'stub',
    baseUrl: `${url}/v1`,
    apiKeyEnv: 'FIXTURE_GATEWAY_KEY',
    region: 'north',
    models: [
      { id: 'large', label: 'Large', price: PRICE },
      { id: 'org/small', label: 'Small' },
      { id: 'big' },
      { id: 'embed', kind: 'embedding' },
    ],
  },
  {
    id: 'far',
    baseUrl: `${url}/far/v1`,
    apiKey: 'far-key',
    region: 'south',
    models: [{ id: 'large' }, { id: 'embed', kind: 'embedding' }],
  },
];

/** Ana's first policy: two chat models and the embedding model, all in the north. */
const ANA_POLICY = {
  allowed: ['stub/large', 'stub/org/small', 'stub/embed'],
  chat: 'stub/org/small',
  regions: ['north'],
};

const policyOf = async (person: Person) => (await person.call('GET', '/api/models')).body.policy;
const setPolicy = (person: Person, policy: object, headers: Record<string, string> = {}) =>
  person.call('PUT', '/api/models/policy', policy, headers);

async function auditRows(where: string, args: unknown[]) {
  const { rows } = await pool.query(
    `select action, outcome, actor_id, rule, before, after, agent_version from audit.events
     where ${where} order by at`,
    args,
  );
  return rows;
}

/** The task a turn created, with its audit row. */
async function createdTask(title: string) {
  const { rows } = await pool.query(
    `select e.agent_version, e.actor_kind from audit.events e
     join app.fixture_tasks t on t.id = e.resource_id
     where e.action = 'task.create' and t.title = $1`,
    [title],
  );
  return rows;
}

beforeAll(async () => {
  gateway = await startGateway();
  process.env.MODEL_PROVIDERS = JSON.stringify(providers(gateway.url));
  process.env.FIXTURE_GATEWAY_KEY = 'stub-secret';
  process.env.AGENT_MODEL = 'stub/large';
  process.env.EMBEDDING_MODEL = 'stub/embed';
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODELS;
  await boot(modelsApp);
  await ana.signUp();
  await sam.signUp();
  await ravi.signUp();
  anaTenant = (await me(ana)).tenantId;
  raviTenant = (await me(ravi)).tenantId;
  await addMember(sam, anaTenant, ['staff']);
  await sam.call('GET', '/api/me', undefined, { 'x-tenant-id': anaTenant });
});

afterAll(async () => {
  for (const n of ENV)
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  await shutdown();
  await gateway?.close();
});

const inAna = (person: Person) => (method: string, path: string, body?: unknown) =>
  person.call(method, path, body, { 'x-tenant-id': anaTenant });

describe('the registry', () => {
  it('holds the configured models, and the fake ones in fake mode', () => {
    const refs = modelRegistry().models.map((m) => m.ref);
    expect(refs).toEqual([
      'stub/large',
      'stub/org/small',
      'stub/big',
      'stub/embed',
      'far/large',
      'far/embed',
      'fake/scripted',
      'fake/embedding',
    ]);
    expect(modelRegistry().defaults).toEqual({
      chat: 'fake/scripted',
      embedding: 'fake/embedding',
    });
  });

  it('prices a call in whole minor units, rounded up; an unpriced model has no cost', () => {
    expect(costOf('stub/large', { inputTokens: 1000, outputTokens: 500 })).toEqual({
      currency: 'XXX',
      minor: 3,
    });
    expect(costOf('stub/org/small', { inputTokens: 1000 })).toBeUndefined();
  });
});

describe('GET /api/models', () => {
  it('a business without a policy: the defaults, and every model with whether it may use it', async () => {
    const res = await ana.call('GET', '/api/models');
    expect(res.status).toBe(200);
    expect(res.body.policy).toEqual({ allowed: [], regions: [] });
    expect(res.body.chat).toEqual({ ref: 'fake/scripted' });
    expect(res.body.embedding).toEqual({ ref: 'fake/embedding' });
    const large = res.body.models.find((m: { ref: string }) => m.ref === 'stub/large');
    expect(large).toEqual({
      ref: 'stub/large',
      kind: 'chat',
      label: 'Large',
      region: 'north',
      allowed: false,
      price: PRICE,
    });
    expect(res.body.models.find((m: { ref: string }) => m.ref === 'fake/scripted').allowed).toBe(
      true,
    );
  });

  it('prices stay hidden from people without models.manage', async () => {
    const res = await inAna(sam)('GET', '/api/models');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('inputPerMillion');
    expect(res.body.models.every((m: object) => !('price' in m))).toBe(true);
  });

  it('people only: the assistant cannot read it', async () => {
    const res = await asAssistant(`user:${ana.id}`, { 'x-tenant-id': anaTenant })(
      'GET',
      '/api/models',
    );
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/models/policy', () => {
  it('an owner sets it through the write path: audited with before and after', async () => {
    const res = await setPolicy(ana, ANA_POLICY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'done', value: ANA_POLICY });
    expect(await policyOf(ana)).toEqual(ANA_POLICY);
    expect((await ana.call('GET', '/api/models')).body.chat).toEqual({ ref: 'stub/org/small' });
    const rows = await auditRows(
      `tenant_id = $1 and action in ('tenant.update', 'models.policy.set')`,
      [anaTenant],
    );
    expect(rows.map((r) => [r.action, r.outcome])).toEqual([
      ['tenant.update', 'committed'],
      ['models.policy.set', 'committed'],
    ]);
    expect(rows[0].before).toEqual({ models: null });
    expect(rows[0].after).toEqual({ models: ANA_POLICY });
    expect(rows[0].actor_id).toBe(ana.id);
  });

  it('another business is unaffected, and cannot be reached', async () => {
    expect(await policyOf(ravi)).toEqual({ allowed: [], regions: [] });
    const across = await ravi.call(
      'PUT',
      '/api/models/policy',
      { allowed: [], regions: [] },
      { 'x-tenant-id': anaTenant },
    );
    expect(across.status).toBe(403);
    const read = await ravi.call('GET', '/api/models', undefined, { 'x-tenant-id': anaTenant });
    expect(read.status).toBe(403);
    expect(await policyOf(ana)).toEqual(ANA_POLICY);
  });

  it('a staff member is refused, and the refusal is audited', async () => {
    const res = await inAna(sam)('PUT', '/api/models/policy', { allowed: [], regions: [] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ rule: 'models_manage' });
    const rows = await auditRows(`action = 'models.policy.set' and actor_id = $1`, [sam.id]);
    expect(rows.map((r) => [r.outcome, r.rule])).toEqual([['denied', 'models_manage']]);
    expect(await policyOf(ana)).toEqual(ANA_POLICY);
  });

  it('the assistant cannot change it', async () => {
    const res = await asAssistant(`user:${ana.id}`, { 'x-tenant-id': anaTenant })(
      'PUT',
      '/api/models/policy',
      { allowed: [], regions: [] },
    );
    expect(res.status).toBe(403);
  });

  it('a policy the deployment cannot honour is a 400 with every problem', async () => {
    const unknown = await setPolicy(ana, { allowed: ['stub/nope'], regions: [] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.problems.join(' ')).toContain('stub/nope is not a model');
    const chatOutside = await setPolicy(ana, {
      allowed: ['stub/large'],
      chat: 'stub/org/small',
      regions: [],
    });
    expect(chatOutside.status).toBe(400);
    expect(chatOutside.body.problems.join(' ')).toContain(
      'does not allow the model stub/org/small',
    );
    const region = await setPolicy(ana, { allowed: ['far/large'], regions: ['north'] });
    expect(region.status).toBe(400);
    expect(region.body.problems.join(' ')).toContain('far/large runs outside the regions north');
    const wrongKind = await setPolicy(ana, { allowed: ['stub/embed'], chat: 'stub/embed' });
    expect(wrongKind.status).toBe(400);
    const typo = await setPolicy(ana, { allow: ['stub/large'] });
    expect(typo.status).toBe(400);
    expect(await policyOf(ana)).toEqual(ANA_POLICY);
  });

  it('an idempotency key replays the stored answer', async () => {
    const policy = { ...ANA_POLICY, regions: ['north'] };
    const key = { 'idempotency-key': `models-${Date.now()}` };
    const first = await setPolicy(ana, policy, key);
    const again = await setPolicy(ana, policy, key);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const conflict = await setPolicy(ana, { ...policy, chat: 'stub/large' }, key);
    expect(conflict.status).toBe(409);
  });

  it('a write hook parks it; the park is audited and approving applies it', async () => {
    const bigger = { ...ANA_POLICY, allowed: [...ANA_POLICY.allowed, BIG_MODEL] };
    const res = await setPolicy(ana, bigger);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('needs_approval');
    expect(await policyOf(ana)).toEqual(ANA_POLICY);
    const approvalId = res.body.approval.id;
    const parked = await auditRows(
      `action = 'models.policy.set' and outcome = 'needs_approval' and tenant_id = $1`,
      [anaTenant],
    );
    expect(parked).toHaveLength(1);
    expect(parked[0].after).toMatchObject({ approvalId });
    const approved = await ana.call('POST', `/api/approvals/${approvalId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect((await policyOf(ana)).allowed).toContain(BIG_MODEL);
    // Back to the first policy, for the tests below.
    expect((await setPolicy(ana, ANA_POLICY)).status).toBe(200);
  });
});

describe('each turn runs on the model the policy chose (scripted model)', () => {
  it("the business's own chat model reaches the agent and the after hooks", async () => {
    const res = await ana.chat('which model');
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Model: stub/org/small.');
    const before = seen.before.find((t) => t.runId === res.body.runId);
    expect(before?.model).toBeUndefined();
    const after = seen.after.find((a) => a.turn.runId === res.body.runId);
    expect(after?.turn.model).toBe('stub/org/small');
  });

  it('a model a hook asks for runs when the business allows it', async () => {
    const res = await ana.chat('use model stub/large, which model');
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Model: stub/large.');
  });

  it('a model the business does not allow refuses the turn: no fallback', async () => {
    const outside = await ana.chat('use model far/large, which model');
    expect(outside.status).toBe(403);
    expect(outside.body).toMatchObject({ error: 'turn_refused', rule: 'model_not_allowed' });
    expect(outside.body.reason).toContain('outside');
    const notListed = await ana.chat('use model stub/big, which model');
    expect(notListed.status).toBe(403);
    expect(notListed.body).toMatchObject({ rule: 'model_not_allowed' });
    const unknown = await ana.chat('use model stub/nope, which model');
    expect(unknown.status).toBe(503);
    expect(unknown.body).toMatchObject({ rule: 'model_unknown' });
  });

  it('a business without a policy runs on the defaults only', async () => {
    expect((await ravi.chat('which model')).body.reply).toBe('Model: fake/scripted.');
    const res = await ravi.chat('use model stub/large, which model');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ rule: 'model_not_allowed' });
  });

  it('the audit row names the model that answered', async () => {
    const title = `Scripted ${Date.now()}`;
    expect((await ana.chat(`add ${title}`)).status).toBe(200);
    const rows = await createdTask(title);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_version).toMatch(/^assistant@fake\/scripted#[0-9a-f]{8}$/);
  });

  it('settings that do not parse refuse the turn and the overview', async () => {
    const config = server.app?.get(TenantConfigService) as TenantConfigService;
    await pool.query(
      `update app.tenants set settings = jsonb_set(settings, '{models}', '{"allowed": "every"}') where id = $1`,
      [raviTenant],
    );
    config.invalidate(raviTenant);
    try {
      const res = await ravi.chat('which model');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ rule: 'model_policy_invalid' });
      expect((await ravi.call('GET', '/api/models')).status).toBe(503);
      // PUT reads the stored row as it is, so the owner can repair it.
      expect((await setPolicy(ravi, { allowed: [], regions: [] })).status).toBe(200);
      expect((await ravi.chat('which model')).status).toBe(200);
    } finally {
      await pool.query(`update app.tenants set settings = settings - 'models' where id = $1`, [
        raviTenant,
      ]);
      config.invalidate(raviTenant);
    }
  });
});

describe('through the gateway (live mode)', () => {
  beforeAll(() => {
    process.env.MODEL_MODE = 'live';
  });
  afterAll(() => {
    process.env.MODEL_MODE = 'fake';
    process.env.GUARDRAILS = 'off';
  });

  const since = () => gateway.requests.length;
  const chatCalls = (from: number) =>
    gateway.requests.slice(from).filter((r) => r.path.endsWith('/chat/completions'));

  it('a turn calls the business’s model with the provider’s key; tools run; usage is reported', async () => {
    const from = since();
    const title = `Gateway ${Date.now()}`;
    const res = await ana.chat(`add ${title}`);
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Done on org/small.');
    const calls = chatCalls(from);
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.path === '/v1/chat/completions')).toBe(true);
    expect(calls.every((c) => c.model === 'org/small')).toBe(true);
    expect(calls.every((c) => c.authorization === 'Bearer stub-secret')).toBe(true);
    const rows = await createdTask(title);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_kind).toBe('agent');
    expect(rows[0].agent_version).toMatch(/^assistant@stub\/org\/small#[0-9a-f]{8}$/);
    const after = seen.after.find((a) => a.turn.runId === res.body.runId);
    expect(after?.turn.model).toBe('stub/org/small');
    expect(after?.outcome.usage?.inputTokens).toBeGreaterThan(0);
    expect(after?.outcome.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('the app’s stream goes the same way', async () => {
    const from = since();
    const title = `Streamed ${Date.now()}`;
    const res = await ana.stream(`add ${title}`);
    expect(res.status).toBe(200);
    const text = res.events
      .filter((e) => e.type === 'text-delta')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Done on org/small.');
    const calls = chatCalls(from);
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.stream && c.model === 'org/small')).toBe(true);
    expect(calls[0].body.stream_options).toEqual({ include_usage: true });
    expect(await createdTask(title)).toHaveLength(1);
  });

  it('a new policy changes the model, and the audit row’s agent version with it', async () => {
    expect((await setPolicy(ana, { ...ANA_POLICY, chat: 'stub/large' })).status).toBe(200);
    const title = `Larger ${Date.now()}`;
    expect((await ana.chat(`add ${title}`)).body.reply).toBe('Done on large.');
    const [row] = await createdTask(title);
    expect(row.agent_version).toMatch(/^assistant@stub\/large#[0-9a-f]{8}$/);
    expect((await setPolicy(ana, ANA_POLICY)).status).toBe(200);
  });

  it('a business without a policy runs on the deployment’s default, and only on it', async () => {
    const from = since();
    expect((await ravi.chat('hello')).body.reply).toBe('Hello from large.');
    expect(chatCalls(from).map((c) => c.model)).toEqual(['large']);
    const res = await ravi.chat('use model stub/org/small, hello');
    expect(res.status).toBe(403);
    expect(chatCalls(from)).toHaveLength(1);
  });

  it('a business in another region reaches that region’s provider, with its key', async () => {
    const policy = { allowed: ['far/large'], chat: 'far/large', regions: ['south'] };
    expect((await setPolicy(ravi, policy)).status).toBe(200);
    const from = since();
    expect((await ravi.chat('hello')).body.reply).toBe('Hello from large.');
    const [call] = chatCalls(from);
    expect(call.path).toBe('/far/v1/chat/completions');
    expect(call.authorization).toBe('Bearer far-key');
  });

  it('the guardrail reads the person’s text on the business’s model only', async () => {
    process.env.GUARDRAILS = 'on';
    try {
      const from = since();
      const res = await ana.chat('hello');
      expect(res.status).toBe(200);
      const calls = chatCalls(from);
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls.some((c) => c.body.response_format)).toBe(true);
      expect(calls.every((c) => c.model === 'org/small' && c.path.startsWith('/v1/'))).toBe(true);
    } finally {
      process.env.GUARDRAILS = 'off';
    }
  });

  it('embeddings go to the business’s embedding model, and a disallowed one is refused', async () => {
    const models = server.app?.get(ModelPolicyService) as ModelPolicyService;
    const from = since();
    const { ref, model } = await models.embeddingFor(anaTenant);
    expect(ref).toBe('stub/embed');
    const out = await model.doEmbed({ values: ['hello', 'hi'] });
    expect(out.embeddings).toEqual([
      [5, 104, 1],
      [2, 104, 1],
    ]);
    const [call] = gateway.requests.slice(from);
    expect(call).toMatchObject({ path: '/v1/embeddings', model: 'embed' });
    expect(call.authorization).toBe('Bearer stub-secret');
    // Ravi allows only far/large: the default embedding model is not his to use.
    const refused = await models.embeddingFor(raviTenant).catch((e) => e);
    expect(refused).toBeInstanceOf(ModelRefused);
    expect(refused.refusal.rule).toBe('model_not_allowed');
  });

  it('a default the deployment does not configure refuses every turn before the hooks', async () => {
    const before = seen.before.length;
    process.env.AGENT_MODEL = 'stub/missing';
    try {
      const res = await ana.chat('hello');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ rule: 'model_not_configured' });
      expect(res.body.reason).toContain('stub/missing');
      expect(seen.before.length).toBe(before);
    } finally {
      process.env.AGENT_MODEL = 'stub/large';
    }
  });
});
