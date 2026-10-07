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
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
  },
};
