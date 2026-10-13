#!/usr/bin/env node
// npm create @hykr/basecamp <folder>   (or pnpm create @hykr/basecamp <folder>)
//
// A new Basecamp application: the sample domain (meetings, notes, to-dos) as a starting point,
// on the published @hykr/* packages. Replace the domain with your own (see DOMAIN.md).
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, '..', 'template');
const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const name = process.argv[2];
if (!name || name.startsWith('-')) {
  console.error('usage: npm create @hykr/basecamp <folder>');
  process.exit(1);
}
const target = resolve(name);
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`${target} is not empty`);
  process.exit(1);
}
if (!existsSync(template)) {
  console.error('This build of create-basecamp carries no template (run its prepack script).');
  process.exit(1);
}

cpSync(template, target, { recursive: true });

/** The framework from npm: every @hykr/* workspace dependency becomes this release. */
const packages = [
  '.',
  ...readdirSync(target).filter((d) => existsSync(join(target, d, 'package.json'))),
];
for (const dir of packages) {
  const file = join(target, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'])
    for (const [dep, range] of Object.entries<string>(pkg[field] ?? {}))
      if (dep.startsWith('@hykr/') && range.startsWith('workspace:'))
        pkg[field][dep] = `^${version}`;
  if (dir === '.') {
    pkg.name = basename(target);
    pkg.packageManager = 'pnpm@12.9.1';
    pkg.engines = { node: '>=24' };
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

writeFileSync(
  join(target, 'pnpm-workspace.yaml'),
  `packages:
${packages
  .filter((d) => d !== '.')
  .map((d) => `  - "${d}"`)
  .join('\n')}

allowBuilds:
  esbuild: true
  onnxruntime-node: false
  "@livekit/local-inference": false
  msgpackr-extract: false

peerDependencyRules:
  allowedVersions:
    "@mastra/evals>vitest": "5"
`,
);
writeFileSync(
  join(target, '.gitignore'),
  [
    'node_modules/',
    'dist/',
    '.expo/',
    '.studio/',
    '.env',
    '*.tsbuildinfo',
    '/mobile/ios/',
    '/mobile/android/',
    '',
  ].join('\n'),
);
writeFileSync(join(target, '.nvmrc'), '24\n');

console.log(`
A Basecamp application in ${target}

  cd ${name}
  pnpm install
  cp .env.example .env       # fill in the secrets: openssl rand -hex 32
  pnpm exec basecamp infra up
  pnpm -r build
  pnpm exec basecamp db migrate
  pnpm exec basecamp dev

Your domain lives in domain/ (contracts, db, server, views, notifications, agent) and the
app's screens in mobile/src/domain and mobile/src/app/(domain). The framework is @hykr/*.
`);
