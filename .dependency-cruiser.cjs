/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'db-policy-not-to-mastra',
      comment: 'packages/db and packages/policy must not import @mastra/*.',
      severity: 'error',
      from: { path: '^packages/(db|policy)/' },
      to: { path: '(^|/)@mastra/' },
    },
    {
      name: 'agents-not-to-db',
      comment:
        'The agent reaches data only through the API. packages/agents must not import packages/db.',
      severity: 'error',
      from: { path: '^packages/agents/' },
      to: { path: ['^packages/db/', '(^|/)@app/db(/|$)'] },
    },
    {
      name: 'core-not-to-mastra',
      comment: 'packages/core uses @mastra/* only in tools/, the agent-facing factory.',
      severity: 'error',
      from: { path: '^packages/core/', pathNot: '^packages/core/(src|dist)/tools/' },
      to: { path: '(^|/)@mastra/' },
    },
    {
      name: 'core-tools-not-to-db',
      comment:
        'packages/core/src/tools is what packages/agents imports: it must not reach the database.',
      severity: 'error',
      from: { path: '^packages/core/(src|dist)/tools/' },
      to: { path: ['^packages/db/', '(^|/)@app/db(/|$)'] },
    },
    {
      name: 'ui-registry-no-runtime',
      comment:
        'The view registry is read by the API (text for WhatsApp and voice) and the apps: it holds only zod, contracts and i18n. React lives in the /react subpath; components live in the apps.',
      severity: 'error',
      from: {
        path: '^packages/ui-registry/(src|dist)/',
        pathNot: '^packages/ui-registry/(src|dist)/react\\.',
      },
      to: {
        path: [
          '^packages/(?!contracts/|i18n/|ui-registry/)',
          '(^|/)@app/(?!contracts|i18n|ui-registry)',
          '(^|/)(react|react-native|expo|@mastra|@nestjs|drizzle-orm)(/|$)',
        ],
      },
    },
    {
      name: 'contracts-stays-a-leaf',
      comment:
        'Specs are shared by the API, the agent and the apps: they depend on zod and the language list (@app/i18n) only.',
      severity: 'error',
      from: { path: '^packages/contracts/' },
      to: { path: ['^packages/(?!contracts/|i18n/)', '(^|/)@app/(?!contracts|i18n)', '^apps/'] },
    },
    {
      name: 'voice-worker-is-a-client',
      comment:
        'The voice worker is another way into the API, like the app: it calls /api/chat and holds no rules, data or model of its own.',
      severity: 'error',
      from: { path: '^apps/voice-worker/src/' },
      to: {
        path: [
          '^packages/(db|policy|core|agents)/',
          '(^|/)@app/(db|policy|core|agents)(/|$)',
          '(^|/)@mastra/',
          '^apps/(?!voice-worker/)',
        ],
      },
    },
    {
      name: 'back-office-is-a-client',
      comment:
        "The back office is the business's window on the API: it calls /api/backoffice through the typed client and holds no rules, data, model or channel code of its own.",
      severity: 'error',
      from: { path: '^apps/back-office/src/' },
      to: {
        path: [
          '^packages/(db|policy|core|agents|channels|notifications)/',
          '(^|/)@app/(db|policy|core|agents|channels|notifications)(/|$)',
          '(^|/)@mastra/',
          '^apps/(?!back-office/)',
        ],
      },
    },
    {
      name: 'channels-is-transport',
      comment:
        'packages/channels moves messages (verify, parse, render, send): no database, policy, framework core, agent, Nest, queue or model in it, so a channel can be tested and replaced on its own.',
      severity: 'error',
      from: { path: '^packages/channels/src/' },
      to: {
        path: [
          '^packages/(db|policy|core|agents)/',
          '(^|/)@app/(db|policy|core|agents)(/|$)',
          '(^|/)(@mastra|@nestjs|drizzle-orm|bullmq)(/|$)',
          '^apps/',
        ],
      },
    },
    {
      name: 'notifications-are-definitions',
      comment:
        'packages/notifications declares templates and notifications: what may be sent, in which words, to whom and when. Sending, consent and queues live in the API.',
      severity: 'error',
      from: { path: '^packages/notifications/src/' },
      to: {
        path: [
          '^packages/(db|policy|core|agents)/',
          '(^|/)@app/(db|policy|core|agents)(/|$)',
          '(^|/)(@mastra|@nestjs|drizzle-orm|bullmq)(/|$)',
          '^apps/',
        ],
      },
    },
    {
      name: 'i18n-is-a-leaf',
      comment:
        "The product's words are read by every app and package, the voice worker included: they import nothing.",
      severity: 'error',
      from: { path: '^packages/i18n/', pathNot: '\\.test\\.ts$' },
      to: { path: ['^packages/(?!i18n/)', '(^|/)@app/', '^apps/', '(^|/)node_modules/'] },
    },
    {
      name: 'framework-reads-the-domain-through-its-index',
      comment:
        "The domain is replaceable: each layer keeps it in one domain/ folder, and everything else imports only that folder's index (see DOMAIN.md). The app's domain routes (src/app/(domain)) belong to the domain.",
      severity: 'error',
      from: { pathNot: ['/(src|dist)/domain/', '^apps/mobile/src/app/\\(domain\\)/'] },
      to: { path: '/(src|dist)/domain/', pathNot: '/(src|dist)/domain/index\\.(ts|tsx|js)$' },
    },
    {
      name: 'packages-not-to-apps',
      comment: 'Apps build on packages, never the reverse.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
  },
};
