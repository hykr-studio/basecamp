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
        'The view registry is read by the API (text for WhatsApp and voice) and the apps: it holds only zod and contracts. React lives in the /react subpath; components live in the apps.',
      severity: 'error',
      from: {
        path: '^packages/ui-registry/(src|dist)/',
        pathNot: '^packages/ui-registry/(src|dist)/react\\.',
      },
      to: {
        path: [
          '^packages/(?!contracts/|ui-registry/)',
          '(^|/)@app/(?!contracts|ui-registry)',
          '(^|/)(react|react-native|expo|@mastra|@nestjs|drizzle-orm)(/|$)',
        ],
      },
    },
    {
      name: 'contracts-stays-a-leaf',
      comment: 'Specs are shared by the API, the agent and the apps: they depend on zod only.',
      severity: 'error',
      from: { path: '^packages/contracts/' },
      to: { path: ['^packages/(?!contracts/)', '(^|/)@app/(?!contracts)', '^apps/'] },
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
