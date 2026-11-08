// `basecamp module add`: the files of both halves and the lines that register them, on a minimal
// application layout in a temporary folder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { insertEntry, insertSorted, MARKER, moduleAdd } from './module-add.js';

let root: string;
const put = (file: string, content: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
};
const read = (file: string) => readFileSync(join(root, file), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'module-add-'));
  put('package.json', JSON.stringify({ basecamp: { server: 'api/dist/server.js', db: 'domain' } }));
  put('domain/package.json', JSON.stringify({ name: '@application/domain' }));
  put(
    'domain/src/modules/index.ts',
    `import { todos } from './todos/index.js';\n\nexport const modules = [\n  todos,\n  // ${MARKER}: one line per module, above this one.\n];\n`,
  );
  for (const [layer, value, list] of [
    ['contracts', 'todosSpec', 'moduleSpecs'],
    ['views', 'todosViews', 'moduleViews'],
  ])
    put(
      `domain/src/${layer}/index.ts`,
      `import { ${value} } from '../modules/todos/${layer}/index.js';\n\nexport * from '../modules/todos/${layer}/index.js';\n\nexport const ${list} = [\n  ${value},\n  // ${MARKER}: one line per module, above this one.\n] as const;\n`,
    );
  mkdirSync(join(root, 'mobile/src/app'), { recursive: true });
});

describe('basecamp module add', () => {
  it('writes the server half: every layer, one entity, its table named after the module', () => {
    const result = moduleAdd({ root, db: 'domain', name: 'orders' });
    for (const file of [
      'contracts/order.ts',
      'contracts/index.ts',
      'db/schema.ts',
      'server/order.entity.ts',
      'server/orders.module.ts',
      'server/public.ts',
      'views/order.ts',
      'views/index.ts',
      'notifications/index.ts',
      'agent/index.ts',
      'index.ts',
    ])
      expect(result.created).toContain(`domain/src/modules/orders/${file}`);
    expect(read('domain/src/modules/orders/contracts/index.ts')).toContain(
      "name: 'orders',\n  // The modules it builds on",
    );
    expect(read('domain/src/modules/orders/db/schema.ts')).toContain("app.table(\n  'orders',");
    expect(read('domain/src/modules/orders/index.ts')).toContain(
      'export const orders = defineModule',
    );
    expect(result.todo.join('\n')).toContain('basecamp db generate --name orders');
  });

  it("writes English words only, and names the application's other languages to add", () => {
    const result = moduleAdd({
      root,
      db: 'domain',
      name: 'orders',
      languages: ['Hindi', 'Telugu'],
    });
    const view = read('domain/src/modules/orders/views/order.ts');
    expect(view).toContain("title: { en: 'Orders' },");
    expect(view).toContain("noun: { en: ['order', 'orders'] },");
    expect(view).not.toMatch(/\b(hi|te):/);
    expect(read('domain/src/modules/orders/contracts/order.ts')).toContain(
      "title: { en: 'Title' },",
    );
    expect(result.todo.join('\n')).toContain('other languages (Hindi, Telugu)');
    // Not known (the server is not built): the step still says to add them.
    const other = moduleAdd({ root, db: 'domain', name: 'invoices' });
    expect(other.todo.join('\n')).toContain('other languages, if it has any,');
  });

  it('registers it: one sorted import and one list entry per barrel, above the marker', () => {
    moduleAdd({ root, db: 'domain', name: 'orders' });
    expect(read('domain/src/modules/index.ts')).toBe(
      `import { orders } from './orders/index.js';\nimport { todos } from './todos/index.js';\n\nexport const modules = [\n  todos,\n  orders,\n  // ${MARKER}: one line per module, above this one.\n];\n`,
    );
    const contracts = read('domain/src/contracts/index.ts');
    expect(contracts).toContain(
      "import { ordersSpec } from '../modules/orders/contracts/index.js';\nimport { todosSpec }",
    );
    expect(contracts).toContain(
      "export * from '../modules/orders/contracts/index.js';\nexport * from '../modules/todos",
    );
    expect(contracts).toContain(`  todosSpec,\n  ordersSpec,\n  // ${MARKER}`);
    expect(read('domain/src/views/index.ts')).toContain(
      `  todosViews,\n  ordersViews,\n  // ${MARKER}`,
    );
  });

  it('writes the app half, and registers it once the app has a modules barrel', () => {
    const first = moduleAdd({ root, db: 'domain', app: 'mobile', name: 'orders' });
    for (const file of [
      'modules/orders/index.tsx',
      'modules/orders/views.tsx',
      'modules/orders/routes.ts',
      'modules/orders/screens/Orders.tsx',
      'app/orders/index.tsx',
    ])
      expect(first.created).toContain(`mobile/src/${file}`);
    expect(read('mobile/src/modules/orders/index.tsx')).toContain(
      "from '@application/domain/modules/orders/views'",
    );
    expect(read('mobile/src/app/orders/index.tsx')).toBe(
      "export { OrdersRoute as default } from '@/modules/orders/routes';\n",
    );
    expect(first.todo[0]).toMatch(/Register orders .* does not exist yet/);

    put(
      'mobile/src/modules/index.ts',
      "// The app modules, one line each.\nexport { todos } from './todos';\n",
    );
    const second = moduleAdd({ root, db: 'domain', app: 'mobile', name: 'invoices' });
    expect(second.registered).toContain('mobile/src/modules/index.ts');
    expect(read('mobile/src/modules/index.ts')).toBe(
      "// The app modules, one line each.\nexport { invoices } from './invoices';\nexport { todos } from './todos';\n",
    );
  });

  it('names a second entity table after the module, and creates missing barrels', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'module-add-'));
    mkdirSync(join(fresh, 'domain'), { recursive: true });
    writeFileSync(join(fresh, 'domain/package.json'), JSON.stringify({ name: '@acme/domain' }));
    moduleAdd({ root: fresh, db: 'domain', name: 'stock', entity: 'item' });
    const schema = readFileSync(join(fresh, 'domain/src/modules/stock/db/schema.ts'), 'utf8');
    expect(schema).toContain("export const stockItems = app.table(\n  'stock_items',");
    const list = readFileSync(join(fresh, 'domain/src/modules/index.ts'), 'utf8');
    expect(list).toContain("import { stock } from './stock/index.js';");
    expect(existsSync(join(fresh, 'domain/src/contracts/index.ts'))).toBe(true);
  });

  it('refuses a bad name, a module that exists, and a name with no singular', () => {
    expect(() => moduleAdd({ root, db: 'domain', name: 'Orders' })).toThrow(/not a module name/);
    expect(() => moduleAdd({ root, db: 'domain', name: 'platform' })).toThrow(/framework/);
    expect(() => moduleAdd({ root, db: 'domain', name: 'stock' })).toThrow(/--entity/);
    moduleAdd({ root, db: 'domain', name: 'orders' });
    expect(() => moduleAdd({ root, db: 'domain', name: 'orders' })).toThrow(/exists already/);
  });
});

describe('the registration helpers', () => {
  it('insert a line in source order, once', () => {
    const src = "import { a } from './a';\nimport { c } from './c';\n";
    const like = /^import .* from '\.\/\w+';$/;
    expect(insertSorted(src, "import { b } from './b';", like)).toBe(
      "import { a } from './a';\nimport { b } from './b';\nimport { c } from './c';\n",
    );
    expect(insertSorted(src, "import { a } from './a';", like)).toBe(src);
  });

  it('insert an entry above the marker, keeping its indent, once', () => {
    const src = `x = [\n    a,\n    // ${MARKER}\n];`;
    expect(insertEntry(src, 'b,')).toBe(`x = [\n    a,\n    b,\n    // ${MARKER}\n];`);
    expect(insertEntry(insertEntry(src, 'b,'), 'b,')).toBe(insertEntry(src, 'b,'));
    expect(() => insertEntry('x = [];', 'b,')).toThrow(/basecamp module add/);
  });
});
