// Golden conversations: whole WhatsApp conversations, written as YAML in ./conversations, run
// against whaloc-test (the Cloud API emulator, webhooks to this app on port 3099) with the
// queues inline and the scripted model. Each file is one conversation; see README.md there for
// the steps and expectations a file may use.
import { readdirSync, readFileSync } from 'node:fs';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { asAssistant, boot, me, Person, pool, server, shutdown } from '../support.js';

const WHALOC = process.env.WHALOC_TEST_URL ?? 'http://localhost:8090';
/** whaloc-test's seeded business number (compose.yaml). */
const NUMBER = '573542517421699';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const DIR = new URL('./conversations/', import.meta.url);

type Step = Record<string, unknown>;
type Conversation = { name: string; steps: Step[] };
type WaMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  type: string;
  payload: {
    text?: { body: string };
    template?: {
      name: string;
      language: { code: string };
      components?: {
        type: string;
        sub_type?: string;
        index?: string;
        parameters?: { payload?: string; text?: string }[];
      }[];
    };
    interactive?: {
      body?: { text: string };
      action?: {
        buttons?: { reply: { id: string; title: string } }[];
        sections?: { rows: { id: string; title: string }[] }[];
      };
    };
  };
};

const available = await fetch(`${WHALOC}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);
if (!available)
  console.warn(`whaloc-test is not running at ${WHALOC}: skipping the golden conversations`);

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.yaml'))
  .sort();
const owner = new Person('Owner Golden');
let tenantId = '';
// biome-ignore lint/suspicious/noExplicitAny: the dist TemplateSync, imported after boot
let sync: any;

const whaloc = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${WHALOC}/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`whaloc ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

/** Wait until a check passes, or fail with what it last saw. */
async function until<T>(what: string, check: () => Promise<T | undefined>, ms = 15_000) {
  const end = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await check();
    if (last !== undefined) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${what}`);
}

/** "/regex/i" is a regex; anything else must appear as written. */
function matches(value: string, pattern: string) {
  const re = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  return re ? new RegExp(re[1], re[2]).test(value) : value.includes(pattern);
}

const SCRIPTS: Record<string, RegExp> = {
  en: /[A-Za-z]/,
  hi: /[ऀ-ॿ]/,
  te: /[ఀ-౿]/,
};

const textOf = (m: WaMessage) =>
  m.payload.text?.body ??
  m.payload.interactive?.body?.text ??
  (m.payload.template
    ? (m.payload.template.components ?? [])
        .flatMap((c) => c.parameters ?? [])
        .map((p) => p.text ?? '')
        .join(' ')
    : '');

beforeAll(async () => {
  if (!available) return;
  Object.assign(process.env, {
    TEST_PORT: '3099',
    WA_GRAPH_URL: WHALOC,
    WA_APP_SECRET: 'test-app-secret',
    WA_VERIFY_TOKEN: 'test-verify-token',
    WA_WABA_ID: '666635535888699',
    WA_PHONE_NUMBER_ID: NUMBER,
    SARVAM_API_KEY: '',
  });
  process.env.APPROVAL_SECRET ||= 'golden-approval-secret-0123456789abcdef';
  await whaloc('POST', '/reset');
  await boot();
  await owner.signUp();
  tenantId = (await me(owner)).tenantId;
  expect(
    (await owner.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
  await pool.query(
    `update app.tenants set settings = settings || '{"quietHours":{"from":"00:00","to":"00:00"}}' where id = $1`,
    [tenantId],
  );
  // Templates as a fresh install has them: created at the provider, then approved.
  const { TemplateSync } = await import('../../dist/channels/templates/template-sync.js');
  const { WHATSAPP } = await import('../../dist/channels/whatsapp/adapter.provider.js');
  const { DB } = await import('../../dist/infra/db.module.js');
  sync = new TemplateSync(server.app?.get(DB), server.app?.get(WHATSAPP), 'http://localhost:8081');
  const created = await sync.run({ create: true });
  expect(created.errors).toEqual([]);
  await until('templates approved', async () => {
    const report = await sync.run({ create: false });
    return report.statuses.every((s: { status: string }) => s.status === 'APPROVED')
      ? true
      : undefined;
  });
}, 60_000);
afterAll(async () => {
  if (available) await shutdown();
});

/** One conversation's people, numbers, saved values and what has been read so far. */
class Run {
  readonly vars: Record<string, unknown> = {};
  private readonly numbers = new Map<string, string>();
  private readonly seen = new Map<string, number>();
  private lastInbound?: Record<string, unknown>;

  constructor(private readonly index: number) {
    // Meeting times the files can use: in two hours, and an hour after that.
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    this.vars.soon = { startsAt: at(120), endsAt: at(150), reminderAt: at(90) };
    this.vars.later = { startsAt: at(180), endsAt: at(210), reminderAt: at(150) };
  }

  /** Each person gets a number of their own for this file. */
  address(who: string) {
    let n = this.numbers.get(who);
    if (!n) {
      n = `91${70 + this.index}${this.numbers.size}${String(Date.now()).slice(-7)}`;
      this.numbers.set(who, n);
    }
    return n;
  }

  /** ${name.path} in strings, from saved values and people. */
  fill<T>(value: T): T {
    if (typeof value === 'string')
      return value.replace(/\$\{([^}]+)\}/g, (_, path: string) => {
        const [head, ...rest] = path.split('.');
        if (head === 'address') return this.address(rest.join('.'));
        let v: unknown = this.vars[head];
        for (const k of rest) v = (v as Record<string, unknown> | undefined)?.[k];
        if (v === undefined) throw new Error(`no value for \${${path}}`);
        return String(v);
      }) as T;
    if (Array.isArray(value)) return value.map((v) => this.fill(v)) as T;
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.fill(v)])) as T;
    return value;
  }

  async contact(who: string) {
    const { rows } = await pool.query(
      'select id, customer_id from channel.contacts where tenant_id = $1 and address = $2',
      [tenantId, this.address(who)],
    );
    return rows[0] as { id: string; customer_id: string | null } | undefined;
  }

  /** A customer known to the business before they write (their records are made first). */
  async ensureContact(who: string) {
    const found = await this.contact(who);
    if (found) return found;
    const { rows } = await pool.query(
      `with c as (insert into app.customers (tenant_id, display_name) values ($1, $2) returning id)
       insert into channel.contacts (tenant_id, address, profile_name, customer_id, welcomed_at)
       select $1, $3, $2, c.id, now() from c returning id, customer_id`,
      [tenantId, who, this.address(who)],
    );
    return rows[0] as { id: string; customer_id: string };
  }

  async messages(who: string): Promise<WaMessage[]> {
    const id = `${NUMBER}:${this.address(who)}`;
    const body = await fetch(`${WHALOC}/api/conversations/${id}/messages?limit=200`).then((r) =>
      r.ok ? r.json() : { data: [] },
    );
    return (body.data as WaMessage[]).filter((m) => m.direction === 'outbound');
  }

  async inbound(who: string, message: Record<string, unknown>) {
    const body = {
      phoneNumberId: NUMBER,
      from: this.address(who),
      profileName: who === 'owner' ? owner.name : who,
      ...message,
    };
    this.lastInbound = body;
    await whaloc('POST', '/inbound', body);
  }

  async step(step: Step) {
    const [kind, raw] = Object.entries(step)[0] ?? [];
    const arg = this.fill(raw) as Record<string, unknown>;
    switch (kind) {
      case 'linkOwner': {
        // The owner's own number, linked to their account (one number per person).
        await pool.query('update channel.contacts set user_id = null where user_id = $1', [
          owner.id,
        ]);
        const c = await this.ensureContact('owner');
        await pool.query(
          'update channel.contacts set user_id = $1, linked_at = now() where id = $2',
          [owner.id, c.id],
        );
        return;
      }
      case 'say':
        return this.inbound(String(arg.as), { type: 'text', text: { body: String(arg.text) } });
      case 'voice': {
        const form = new FormData();
        const bytes = `FAKE-STT:${arg.lang}:${arg.text}`;
        form.append('file', new Blob([bytes], { type: 'audio/ogg' }), 'note.ogg');
        form.append('phoneNumberId', NUMBER);
        form.append('type', 'audio/ogg');
        const res = await fetch(`${WHALOC}/api/inbound-media`, { method: 'POST', body: form });
        const { data } = (await res.json()) as { data: { id: string } };
        return this.inbound(String(arg.as), {
          type: 'audio',
          media: { id: data.id, voice: true },
        });
      }
      case 'tap':
        return this.tap(arg);
      case 'repeat':
        if (!this.lastInbound) throw new Error('nothing to repeat');
        return whaloc('POST', '/inbound', this.lastInbound);
      case 'redeliver': {
        // Meta delivering the same webhook again: the last message from this person.
        const last = (
          await fetch(
            `${WHALOC}/api/conversations/${NUMBER}:${this.address(String(arg.as))}/messages?limit=200`,
          ).then((r) => r.json())
        ).data
          .filter((m: WaMessage) => m.direction === 'inbound')
          .at(-1) as WaMessage;
        const { data } = await whaloc('GET', '/webhook-deliveries?limit=100');
        const delivery = (data as { id: string; requestBody: string }[]).find((d) =>
          d.requestBody.includes(last.id),
        );
        if (!delivery) throw new Error('no delivery to redeliver');
        return whaloc('POST', `/webhook-deliveries/${delivery.id}/redeliver`);
      }
      case 'shiftWindow': {
        const c = await this.contact(String(arg.as));
        await pool.query(
          `update channel.messages set at = at - make_interval(hours => $2) where contact_id = $1 and direction = 'in'`,
          [c?.id, Number(arg.hours)],
        );
        return;
      }
      case 'inject':
        // The next send fails, as Meta would answer it.
        return whaloc('POST', '/injection-rules', {
          target: 'messages.send',
          trigger: { kind: 'next', count: Number(arg.count ?? 1) },
          ...(arg.code
            ? {
                preset: 'custom',
                custom: {
                  httpStatus: Number(arg.status ?? 400),
                  code: Number(arg.code),
                  message: String(arg.message ?? 'Injected failure'),
                },
              }
            : { preset: String(arg.preset ?? 'rate_limit_429'), retryAfterSeconds: 1 }),
        });
      case 'api': {
        const who = String(arg.as);
        const call =
          who === 'owner'
            ? owner.call.bind(owner)
            : asAssistant(`contact:${(await this.ensureContact(who)).id}`);
        const res = await call(String(arg.method ?? 'GET'), String(arg.path), arg.body);
        if (arg.status !== undefined) expect(res.status).toBe(Number(arg.status));
        else expect(res.status).toBeLessThan(400);
        if (arg.save) this.vars[String(arg.save)] = res.body;
        return;
      }
      case 'fire': {
        // Run a scheduled notification now instead of waiting for its time.
        const { NotifyService, scheduledJobId } = await import(
          '../../dist/channels/notify/notify.service.js'
        );
        const dedupe = String(arg.dedupe);
        const at = await until(
          `${dedupe} scheduled`,
          async () => (await server.app?.get(NotifyService).scheduledFor(dedupe)) ?? undefined,
        );
        const queue = server.app?.get(getQueueToken('notify-dispatch'), { strict: false }) as Queue;
        const job = await until(
          `${dedupe} job`,
          async () => (await queue.getJob(scheduledJobId(dedupe, at))) ?? undefined,
        );
        await job.promote();
        return;
      }
      case 'template': {
        // What Meta decides about a template, then the sync that records it.
        const { data } = await whaloc('GET', '/templates');
        for (const t of data as { id: string; name: string }[])
          if (t.name === arg.name)
            await whaloc('POST', `/templates/${t.id}/${arg.status}`, {
              ...(arg.status === 'reject' ? { reason: 'INVALID_FORMAT' } : {}),
            });
        await sync.run({ create: false });
        return;
      }
      case 'wait':
        return new Promise((r) => setTimeout(r, Number(raw)));
      case 'expect':
        return this.expectMessage(arg);
      case 'expectNone': {
        const who = String(arg.to);
        await new Promise((r) => setTimeout(r, Number(arg.for ?? 2500)));
        const fresh = (await this.messages(who)).slice(this.seen.get(who) ?? 0);
        expect(fresh.map(textOf), `nothing more to ${who}`).toEqual([]);
        return;
      }
      case 'expectEmail': {
        const to = arg.to === 'owner' ? owner.email : String(arg.to);
        await until(`email to ${to} matching ${arg.subject}`, async () => {
          const res = await fetch(
            `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
          );
          const { messages } = (await res.json()) as { messages: { Subject: string }[] };
          return messages.find((m) => matches(m.Subject, String(arg.subject)));
        });
        return;
      }
      case 'expectDb': {
        const params = this.params(arg.params);
        const check = async () => {
          const { rows } = await pool.query(String(arg.sql), params);
          try {
            expect(rows).toEqual(arg.rows);
            return rows;
          } catch {
            return undefined;
          }
        };
        const rows = await until(`db: ${arg.sql}`, check).catch(async () => {
          const { rows } = await pool.query(String(arg.sql), params);
          expect(rows).toEqual(arg.rows);
          return rows;
        });
        return rows;
      }
      case 'query': {
        const { rows } = await pool.query(String(arg.sql), this.params(arg.params));
        this.vars[String(arg.save)] = rows[0];
        return;
      }
      case 'expectScheduled': {
        // When a notification will go (null: not scheduled), to the minute.
        const { NotifyService } = await import('../../dist/channels/notify/notify.service.js');
        const minute = (iso: unknown) => (iso ? String(iso).slice(0, 16) : null);
        await until(`${arg.dedupe} at ${arg.at}`, async () => {
          const at = await server.app?.get(NotifyService).scheduledFor(String(arg.dedupe));
          return minute(at) === minute(arg.at) ? true : undefined;
        });
        return;
      }
      case 'expectAudit': {
        await until(`audit ${arg.action}`, async () => {
          const { rows } = await pool.query(
            'select count(*)::int as n from audit.events where tenant_id = $1 and action = $2',
            [tenantId, arg.action],
          );
          return rows[0].n === Number(arg.count ?? 1) ? true : undefined;
        });
        return;
      }
      default:
        throw new Error(`unknown step: ${kind}`);
    }
  }

  /** Query parameters: $tenant and $owner stand for this run's business and owner. */
  private params(list: unknown) {
    return ((list as unknown[]) ?? []).map((p) =>
      p === '$tenant' ? tenantId : p === '$owner' ? owner.id : p,
    );
  }

  /** Tap a button on the latest message to `sentTo` (default: the one tapping) that has it. */
  private async tap(arg: Record<string, unknown>) {
    const who = String(arg.as);
    const sentTo = String(arg.sentTo ?? who);
    const title = String(arg.button);
    const { templates } = await import('@app/notifications');
    for (const m of (await this.messages(sentTo)).reverse()) {
      const button = m.payload.interactive?.action?.buttons?.find((b) => b.reply.title === title);
      if (button)
        return this.inbound(who, {
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: button.reply },
        });
      const row = m.payload.interactive?.action?.sections
        ?.flatMap((s) => s.rows)
        .find((r) => r.title === title);
      if (row)
        return this.inbound(who, {
          type: 'interactive',
          interactive: { type: 'list_reply', list_reply: { id: row.id, title: row.title } },
        });
      const t = m.payload.template;
      if (t) {
        const def = templates.find((d) => d.name === t.name);
        const lang = t.language.code as 'en' | 'hi' | 'te';
        const quick = (def?.buttons ?? []).filter((b) => b.type === 'quick_reply');
        const index = quick.findIndex((b) => b.text[lang] === title || b.text.en === title);
        const payload = (t.components ?? []).find(
          (c) => c.type === 'button' && c.sub_type === 'quick_reply' && Number(c.index) === index,
        )?.parameters?.[0]?.payload;
        if (index >= 0 && payload)
          return this.inbound(who, { type: 'button', button: { payload, text: title } });
      }
    }
    throw new Error(`no "${title}" button in messages to ${sentTo}`);
  }

  /** The next message to them that matches; earlier unmatched ones are passed over. */
  private async expectMessage(arg: Record<string, unknown>) {
    const who = String(arg.to);
    const from = this.seen.get(who) ?? 0;
    const describe = JSON.stringify(arg);
    const found = await until(
      `a message to ${who}: ${describe}`,
      async () => {
        const all = await this.messages(who);
        for (let i = from; i < all.length; i++) {
          const m = all[i];
          const text = textOf(m);
          if (arg.text && !matches(text, String(arg.text))) continue;
          if (arg.template && m.payload.template?.name !== arg.template) continue;
          if (arg.lang && !SCRIPTS[String(arg.lang)]?.test(text)) continue;
          if (arg.buttons) {
            const titles = (m.payload.interactive?.action?.buttons ?? []).map((b) => b.reply.title);
            if (JSON.stringify(titles) !== JSON.stringify(arg.buttons)) continue;
          }
          return { i, m };
        }
        return undefined;
      },
      Number(arg.within ?? 15_000),
    ).catch(async (e) => {
      const all = (await this.messages(who)).slice(from).map(textOf);
      throw new Error(`${(e as Error).message}\n  sent since: ${JSON.stringify(all, null, 1)}`);
    });
    this.seen.set(who, found.i + 1);
  }
}

describe.skipIf(!available)('golden conversations', () => {
  files.forEach((file, index) => {
    const conversation = parse(readFileSync(new URL(file, DIR), 'utf8')) as Conversation;
    it(`${file}: ${conversation.name}`, async () => {
      const run = new Run(index);
      for (const [i, step] of conversation.steps.entries()) {
        try {
          await run.step(step);
        } catch (e) {
          throw new Error(
            `step ${i + 1} (${JSON.stringify(step)}): ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    }, 120_000);
  });
});
