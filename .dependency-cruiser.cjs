// The repository's boundaries. framework/ is Basecamp, published as @hykr/* packages;
// application/ is one application built on it (the sample domain). The framework never
// imports an application, and an application reaches the framework only through the
// packages' public exports, as it would from npm.

/** The framework's runtimes: they host an application rather than serve as building blocks. */
const RUNTIMES = 'api|app|back-office|voice-worker|cli|create-basecamp';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /* ── The line between the framework and the application ─────────────────── */
    {
      name: 'framework-never-imports-application',
      comment:
        'The framework is published on its own: nothing in framework/ may import application code. An application passes its domain in (defineServer, AppShell).',
      severity: 'error',
      from: { path: '^framework/' },
      to: { path: ['^application/', '(^|/)@application/'] },
    },
    {
      name: 'application-uses-public-framework-exports',
      comment:
        "An application imports @hykr/* packages by name, as from npm: no relative paths into framework/, no package's src/ or tests.",
      severity: 'error',
      from: { path: '^application/' },
      to: { path: ['^framework/[^/]+/(src|test)/', '(^|/)@hykr/[^/]+/(src|dist|test)/'] },
    },
    {
      name: 'framework-libraries-not-to-runtimes',
      comment:
        'The runtimes (API, app shell, back office, voice worker, CLI) build on the libraries, never the reverse.',
      severity: 'error',
      from: { path: `^framework/(?!${RUNTIMES}/)[^/]+/` },
      to: { path: `^framework/(${RUNTIMES})/` },
    },

    /* ── Inside the framework ───────────────────────────────────────────────── */
    {
      name: 'db-policy-not-to-mastra',
      comment: 'framework/db and framework/policy must not import @mastra/*.',
      severity: 'error',
      from: { path: '^framework/(db|policy)/' },
      to: { path: '(^|/)@mastra/' },
    },
    {
      name: 'agents-not-to-db',
      comment:
        'The agent reaches data only through the API. framework/agents must not import framework/db.',
      severity: 'error',
      from: { path: '^framework/agents/' },
      to: { path: ['^framework/db/', '(^|/)@hykr/db(/|$)'] },
    },
    {
      name: 'core-not-to-mastra',
      comment: 'framework/core uses @mastra/* only in tools/, the agent-facing factory.',
      severity: 'error',
      from: { path: '^framework/core/', pathNot: '^framework/core/(src|dist)/tools/' },
      to: { path: '(^|/)@mastra/' },
    },
    {
      name: 'core-tools-not-to-db',
      comment:
        'framework/core/src/tools is what framework/agents imports: it must not reach the database.',
      severity: 'error',
      from: { path: '^framework/core/(src|dist)/tools/' },
      to: { path: ['^framework/db/', '(^|/)@hykr/db(/|$)'] },
    },
    {
      name: 'ui-registry-no-runtime',
      comment:
        'The view registry is read by the API (text for WhatsApp and voice) and the apps: it holds only zod, contracts and i18n. React lives in the /react subpath; components live in the apps.',
      severity: 'error',
      from: {
        path: '^framework/ui-registry/(src|dist)/',
        pathNot: '^framework/ui-registry/(src|dist)/react\\.',
      },
      to: {
        path: [
          '^framework/(?!contracts/|i18n/|ui-registry/)',
          '(^|/)@hykr/(?!contracts|i18n|ui-registry)',
          '(^|/)(react|react-native|expo|@mastra|@nestjs|drizzle-orm)(/|$)',
        ],
      },
    },
    {
      name: 'contracts-stays-a-leaf',
      comment:
        'Specs are shared by the API, the agent and the apps: they depend on zod and the language list (@hykr/i18n) only.',
      severity: 'error',
      from: { path: '^framework/contracts/' },
      to: { path: ['^framework/(?!contracts/|i18n/)', '(^|/)@hykr/(?!contracts|i18n)'] },
    },
    {
      name: 'clients-hold-no-server-code',
      comment:
        'The app shell, the back office and the voice worker are ways into the API: they call it through the typed client and hold no rules, data, model or channel code of their own.',
      severity: 'error',
      from: { path: '^framework/(app|back-office|voice-worker)/src/' },
      to: {
        path: [
          '^framework/(db|policy|core|agents|channels|notifications|api)/',
          '(^|/)@hykr/(db|policy|core|agents|channels|notifications|api)(/|$)',
          '(^|/)(@mastra|@nestjs|drizzle-orm|bullmq)(/|$)',
        ],
      },
    },
    {
      name: 'channels-is-transport',
      comment:
        'framework/channels moves messages (verify, parse, render, send): no database, policy, framework core, agent, Nest, queue or model in it, so a channel can be tested and replaced on its own.',
      severity: 'error',
      from: { path: '^framework/channels/src/' },
      to: {
        path: [
          '^framework/(db|policy|core|agents)/',
          '(^|/)@hykr/(db|policy|core|agents)(/|$)',
          '(^|/)(@mastra|@nestjs|drizzle-orm|bullmq)(/|$)',
        ],
      },
    },
    {
      name: 'notifications-are-definitions',
      comment:
        'framework/notifications declares templates and notifications: what may be sent, in which words, to whom and when. Sending, consent and queues live in the API.',
      severity: 'error',
      from: { path: '^framework/notifications/src/' },
      to: {
        path: [
          '^framework/(db|policy|core|agents)/',
          '(^|/)@hykr/(db|policy|core|agents)(/|$)',
          '(^|/)(@mastra|@nestjs|drizzle-orm|bullmq)(/|$)',
        ],
      },
    },
    {
      name: 'i18n-is-a-leaf',
      comment:
        "The product's words are read by every app and package, the voice worker included: they import nothing.",
      severity: 'error',
      from: { path: '^framework/i18n/', pathNot: '\\.test\\.ts$' },
      to: { path: ['^framework/(?!i18n/)', '(^|/)@hykr/', '(^|/)node_modules/'] },
    },

    /* ── Inside the application ─────────────────────────────────────────────── */
    {
      name: 'domain-specs-and-views-are-isomorphic',
      comment:
        "The domain's contracts, views and notifications are read by the server and the apps alike: no database, Nest, model or server-only framework package in them.",
      severity: 'error',
      from: { path: '^application/domain/(src|dist)/(contracts|views|notifications)/' },
      to: {
        path: [
          '^application/domain/(src|dist)/(server|db|agent)/',
          '^framework/(db|policy|core|agents|api)/',
          '(^|/)@hykr/(db|policy|core|agents|api)(/|$)',
          '(^|/)(@mastra|@nestjs|drizzle-orm|bullmq)(/|$)',
        ],
      },
    },
    {
      name: 'apps-read-only-isomorphic-domain',
      comment:
        "The Expo apps read the domain's contracts and views only: never its server, tables or assistant.",
      severity: 'error',
      from: { path: '^application/(mobile|back-office)/' },
      to: {
        path: [
          '^application/domain/(src|dist)/(server|db|agent)/',
          '^application/api/',
          '^framework/(db|policy|core|agents|api|channels|notifications)/',
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // create-basecamp's template/ is a copy of application/, made when the package is packed.
    exclude: { path: '^framework/create-basecamp/template/' },
    tsPreCompilationDeps: true,
  },
};
