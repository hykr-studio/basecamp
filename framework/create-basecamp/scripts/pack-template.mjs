// Copies the sample application (../../application in the Basecamp repository) into template/,
// so the published scaffolder carries it. Runs before `npm pack` / `npm publish` (prepack).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', '..', 'application');
const target = join(here, '..', 'template');
const SKIP = new Set([
  'node_modules',
  'dist',
  '.expo',
  '.turbo',
  '.studio',
  'ios',
  'android',
  '.env',
]);

if (!existsSync(source)) throw new Error(`No application at ${source}`);
rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  filter: (path) => !SKIP.has(basename(path)) && !path.endsWith('.tsbuildinfo'),
});
console.log(`template: ${source} → ${target}`);
