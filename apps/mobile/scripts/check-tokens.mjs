// The colour tokens live twice: src/theme.ts (StyleSheet) and global.css (Tailwind classes).
// This fails if they drift apart, so a colour changed in one place can't silently split the UI.
import { readFileSync } from 'node:fs';

const theme = readFileSync(new URL('../src/theme.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../global.css', import.meta.url), 'utf8');

const block = /export const colors = \{([\s\S]*?)\n\};/.exec(theme)?.[1] ?? '';
const kebab = (name) => name.replace(/([A-Z])/g, '-$1').toLowerCase();
const problems = [];
for (const [, name, value] of block.matchAll(/^\s+(\w+): '(#[0-9a-fA-F]{3,8})'/gm)) {
  const m = new RegExp(`--color-${kebab(name)}:\\s*(#[0-9a-fA-F]{3,8});`).exec(css);
  if (!m) problems.push(`global.css has no --color-${kebab(name)} (theme.ts ${name})`);
  else if (m[1].toLowerCase() !== value.toLowerCase())
    problems.push(`--color-${kebab(name)} is ${m[1]} in global.css but ${value} in theme.ts`);
}
if (problems.length) {
  console.error(`Design tokens drifted:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Design tokens match.');
