// `basecamp module add <name>`: a new application module, both halves, and the lines that
// register it. The server half goes to <db>/src/modules/<name>/ (contracts, db, server, views,
// notifications, agent, index.ts); the app half to <app>/src/modules/<name>/ (index.tsx,
// views.tsx, routes.ts, screens/) and the route <app>/src/app/<name>/index.tsx, a one-line
// re-export. Everything it writes builds as is: one entity with a title, its table, a list view,
// a list screen, and empty notifications and agent parts to fill in.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Where the module goes, and what it is called. */
export type ModuleAddInput = {
  /** The application's root (the package.json with the basecamp block). */
  root: string;
  /** The domain package, relative to root (the basecamp block's `db`). */
  db: string;
  /** The Expo app that gets the app half, relative to root (the first of `apps` with src/app). */
  app?: string;
  /** The module's name: lower case, the plural of its entity ('orders'). */
  name: string;
  /** The entity's singular name. Default: the module's name without its final s. */
  entity?: string;
  /**
   * The application's languages other than English, by name ("Hindi"): the words it writes are
   * English, and the next steps say to translate them into these. Unknown: none named.
   */
  languages?: readonly string[];
};

export type ModuleAddResult = {
  /** Files written, relative to root. */
  created: string[];
  /** Files a registration line was added to, relative to root. */
  registered: string[];
  /** What is left to do by hand. */
  todo: string[];
};

const MODULE_NAME = /^[a-z][a-z0-9_]*$/;
/** The line every list a module is registered in ends with. */
export const MARKER = 'basecamp module add';

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const pascal = (s: string) => camel(s).replace(/^./, (c) => c.toUpperCase());
const words = (s: string) => s.replace(/_/g, ' ');
const title = (s: string) => words(s).replace(/^./, (c) => c.toUpperCase());

/** What an import or export line is sorted by: its source, as Biome sorts them. */
const sourceOf = (line: string) => /from '([^']+)'/.exec(line)?.[1] ?? line;

/** Insert `line` among the lines matching `like`, keeping them sorted; after the last one. */
export function insertSorted(source: string, line: string, like: RegExp): string {
  const lines = source.split('\n');
  if (lines.includes(line)) return source;
  const matching = lines.map((l, i) => (like.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!matching.length) throw new Error(`no line like ${like} to add "${line}" next to`);
  const before = matching.find((i) => sourceOf(lines[i]) > sourceOf(line));
  lines.splice(before ?? (matching.at(-1) as number) + 1, 0, line);
  return lines.join('\n');
}

/** Insert `entry` as the last item of the list that ends with the MARKER comment. */
export function insertEntry(source: string, entry: string): string {
  const lines = source.split('\n');
  const at = lines.findIndex((l) => l.includes(MARKER) && l.trim().startsWith('//'));
  if (at < 0) throw new Error(`no "// ${MARKER}" line to add "${entry.trim()}" above`);
  if (lines.some((l) => l.trim() === entry.trim())) return source;
  const indent = /^\s*/.exec(lines[at])?.[0] ?? '  ';
  lines.splice(at, 0, `${indent}${entry.trim()}`);
  return lines.join('\n');
}

/** Write the server half, the app half and the registration lines. Throws on a bad name. */
export function moduleAdd(input: ModuleAddInput): ModuleAddResult {
  const { root, db, app, name } = input;
  if (!MODULE_NAME.test(name))
    throw new Error(`"${name}" is not a module name: lower case letters, digits and _`);
  if (name === 'platform') throw new Error('"platform" is the framework\'s own module');
  const entity = input.entity ?? (name.endsWith('s') ? name.slice(0, -1) : '');
  if (!entity)
    throw new Error(`give the entity's singular name: basecamp module add ${name} --entity <name>`);
  if (!/^[a-z][a-zA-Z0-9_]*$/.test(entity)) throw new Error(`"${entity}" is not an entity name`);
  const domain = join(root, db, 'src');
  const dir = join(domain, 'modules', name);
  if (existsSync(dir)) throw new Error(`${relative(root, dir)} exists already`);
  const domainPackage = JSON.parse(readFileSync(join(root, db, 'package.json'), 'utf8')).name;

  const n = {
    module: name,
    m: camel(name),
    entity,
    E: pascal(entity),
    plural: `${entity}s`,
    table: `${entity}s` === name ? name : `${name}_${entity}s`,
    tableVar: camel(`${entity}s` === name ? name : `${name}_${entity}s`),
    label: words(entity),
    Title: title(`${entity}s`),
    domainPackage,
  };
  const result: ModuleAddResult = { created: [], registered: [], todo: [] };
  const write = (file: string, content: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    result.created.push(relative(root, file));
  };
  for (const [file, content] of Object.entries(serverFiles(n))) write(join(dir, file), content);

  // The server's list of modules, and the apps' aggregates of specs and views.
  const register = (file: string, edit: (source: string) => string, fresh: string) => {
    const path = join(domain, file);
    if (existsSync(path)) writeFileSync(path, edit(readFileSync(path, 'utf8')));
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, fresh);
    }
    result.registered.push(relative(root, path));
  };
  register(
    'modules/index.ts',
    (s) =>
      insertEntry(
        insertSorted(
          s,
          `import { ${n.m} } from './${name}/index.js';`,
          /^import \{ \w+ \} from '\.\/[a-z0-9_]+\/index\.js';$/,
        ),
        `${n.m},`,
      ),
    modulesList(n),
  );
  for (const [layer, value] of [
    ['contracts', `${n.m}Spec`],
    ['views', `${n.m}Views`],
  ] as const) {
    const path = `../modules/${name}/${layer}/index.js`;
    register(
      `${layer}/index.ts`,
      (s) =>
        insertEntry(
          insertSorted(
            insertSorted(
              s,
              `import { ${value} } from '${path}';`,
              /^import \{ \w+ \} from '\.\.\/modules\/[a-z0-9_]+\/\w+\/index\.js';$/,
            ),
            `export * from '${path}';`,
            /^export \* from '\.\.\/modules\/[a-z0-9_]+\/\w+\/index\.js';$/,
          ),
          `${value},`,
        ),
      aggregate(layer, value, path),
    );
  }

  // The app half: its components, its route, and its registration once the app has a modules list.
  if (app) {
    const appDir = join(root, app, 'src');
    const defineAppModule = appHasDefineAppModule(join(root, app));
    for (const [file, content] of Object.entries(appFiles(n, defineAppModule)))
      write(join(appDir, file), content);
    // The app's modules barrel: one `export { name } from './name';` line per module.
    const list = join(appDir, 'modules', 'index.ts');
    if (existsSync(list)) {
      writeFileSync(
        list,
        insertSorted(
          readFileSync(list, 'utf8'),
          `export { ${n.m} } from './${name}';`,
          /^export \{ \w+ \} from '\.\/[a-z0-9_-]+';$/,
        ),
      );
      result.registered.push(relative(root, list));
    } else
      result.todo.push(
        `Register ${n.m} (${relative(root, join(appDir, 'modules', name))}) with the app shell: ${relative(root, list)} does not exist yet.`,
      );
  }
  result.todo.push(`Generate the migration for its table: basecamp db generate --name ${name}`);
  const others = input.languages ?? [];
  result.todo.push(
    `Its words are English only (other languages read them in English): add the application's ${others.length ? `other languages (${others.join(', ')})` : 'other languages, if it has any,'} to the labels in ${relative(root, join(dir, 'views', `${entity}.ts`))} and ${relative(root, join(dir, 'contracts', `${entity}.ts`))}.`,
  );
  return result;
}

/** Does this app's @hykr/app have defineAppModule (the app half's registration)? */
function appHasDefineAppModule(app: string): boolean {
  for (let d = app; ; d = dirname(d)) {
    const types = join(d, 'node_modules', '@hykr', 'app', 'dist', 'index.d.ts');
    if (existsSync(types)) return readFileSync(types, 'utf8').includes('defineAppModule');
    if (dirname(d) === d) return false;
  }
}

type Names = {
  module: string;
  m: string;
  entity: string;
  E: string;
  plural: string;
  table: string;
  tableVar: string;
  label: string;
  Title: string;
  domainPackage: string;
};

const modulesList = (n: Names) => `/**
 * The application's modules, in dependency order (a module after the ones it depends on): what
 * the server definition gives defineServer. Server only. One line per module.
 */
import { ${n.m} } from './${n.module}/index.js';

export const modules = [
  ${n.m},
  // ${MARKER}: one line per module, above this one.
];
`;

const aggregate = (layer: string, value: string, path: string) => `/**
 * Every module's ${layer}, for the apps: isomorphic, like the module folders it gathers. One line
 * per module, in module order.
 */
import { ${value} } from '${path}';

export * from '${path}';

export const module${layer === 'contracts' ? 'Specs' : 'Views'} = [
  ${value},
  // ${MARKER}: one line per module, above this one.
] as const;
`;

/** The server half, by path inside the module's folder. */
function serverFiles(n: Names): Record<string, string> {
  return {
    [`contracts/${n.entity}.ts`]: `import { CreatedBy, entitySpec } from '@hykr/contracts';
import { z } from 'zod';

const title = z.string().min(1).max(200);

export const ${n.E}View = z.object({
  id: z.string(),
  title,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type ${n.E}View = z.infer<typeof ${n.E}View>;

export const Create${n.E}Input = z.object({ title });
export const Update${n.E}Input = z.object({ title: title.optional() });

export const ${n.E}Spec = entitySpec({
  name: '${n.entity}',
  label: '${n.label}',
  // What the assistant reads to choose its tools: say what one is and when to use it.
  description: '${n.Title}: each has a title.',
  schemas: { read: ${n.E}View, create: Create${n.E}Input, update: Update${n.E}Input },
  // Each field's name, in English and in the application's other languages (they fall back
  // to English).
  fieldLabels: {
    title: { en: 'Title' },
  },
  list: {
    filterable: { title: 'text', createdAt: 'date' },
    sortable: ['createdAt', 'title'],
    defaultSort: [['createdAt', 'desc']],
    search: ['title'],
    pageSize: { default: 25, max: 100 },
    examples: { title: '{ "contains": "first" }' },
  },
  // An agent never deletes without the person.
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: '${n.entity}.list' },
});
`,
    'contracts/index.ts': `/** The ${words(n.module)} module's specs: isomorphic, read by the server and the apps. */
import { moduleSpec } from '@hykr/contracts';
import { ${n.E}Spec } from './${n.entity}.js';

export * from './${n.entity}.js';

export const ${n.m}Spec = moduleSpec({
  name: '${n.module}',
  // The modules it builds on: it may import only their contracts/ and server/public.ts.
  dependsOn: [],
  entities: { ${n.plural}: ${n.E}Spec },
  commands: [],
});
`,
    'db/schema.ts': `/** The ${words(n.module)} module's tables, named after the module. */
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { index, text, timestamp } from 'drizzle-orm/pg-core';

export const ${n.tableVar} = app.table(
  '${n.table}',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    /** Who made the row: the person, or the assistant acting for them. Set by the framework. */
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('${n.table}_tenant_customer_idx').on(table.tenantId, table.customerId)],
);
`,
    [`server/${n.entity}.entity.ts`]: `import { defineEntity } from '@hykr/core';
import { ${n.E}Spec } from '../contracts/index.js';
import { ${n.tableVar} } from '../db/schema.js';

/**
 * ${n.Title}: plain CRUD. Without \`access\`, people reach their own rows and a customer theirs;
 * give it an \`Access\` (@hykr/policy) to open more to a role.
 */
export const ${n.E} = defineEntity(${n.E}Spec, {
  table: ${n.tableVar},
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
});
`,
    [`server/${n.module}.module.ts`]: `import { entityController, entityHandlers } from '@hykr/core';
import { Module } from '@nestjs/common';
import { ${n.E} } from './${n.entity}.entity.js';

@Module({
  controllers: [entityController(${n.E})],
  providers: [...entityHandlers(${n.E})],
})
export class ${pascal(n.module)}Module {}
`,
    'server/public.ts': `/**
 * What other modules may use of the ${words(n.module)} module on the server (those that list it in
 * their dependsOn). Everything else in server/ is the module's own.
 */
export { ${n.E} } from './${n.entity}.entity.js';
`,
    [`views/${n.entity}.ts`]: `import { pick } from '@hykr/i18n';
import { defineView, spokenList, type ViewLabels } from '@hykr/ui-registry';
import { z } from 'zod';
import { ${n.E}Spec, ${n.E}View } from '../contracts/index.js';

// English; add the application's other languages beside it (\`de: 'Aufgaben'\`). A language
// left out reads in English.
const labels = {
  title: { en: '${n.Title}' },
  empty: { en: 'No ${n.label}s.' },
  noun: { en: ['${n.label}', '${n.label}s'] },
} satisfies ViewLabels;

export const ${n.E}ListView = defineView({
  name: '${n.entity}.list',
  description: 'A list of ${n.label}s, newest first.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(${n.E}View) }),
  source: { entity: ${n.E}Spec, into: 'items' },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? [p.title, ...p.items.map((x) => \`• \${x.title}\`)].filter(Boolean).join('\\n')
      : pick(labels.empty, ctx.lang),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((x) => x.title),
      labels,
      ctx,
    ),
});
`,
    'views/index.ts': `/** The ${words(n.module)} module's views and screens. Isomorphic. */
import type { UiPart, ViewDef } from '@hykr/ui-registry';
import { ${n.E}ListView } from './${n.entity}.js';

export * from './${n.entity}.js';

export const ${n.m}Views: UiPart = {
  name: '${n.module}',
  views: [${n.E}ListView] as unknown as readonly ViewDef[],
  screens: [],
};
`,
    'notifications/index.ts': `/**
 * The ${words(n.module)} module's WhatsApp templates and notifications (defineTemplate,
 * defineNotification from @hykr/notifications). Isomorphic.
 */
import type { NotificationsDomain } from '@hykr/notifications';

export const ${n.m}Notifications: NotificationsDomain = {
  templates: [],
  notifications: [],
};
`,
    'agent/index.ts': `/**
 * What the ${words(n.module)} module teaches the assistant: its rules, the scripted model's scripts
 * (MODEL_MODE=fake) and its evals (\`basecamp eval --module ${n.module}\`). A script's verbs must not
 * take another module's eval turns: defineServer checks it at boot.
 */
import type { AgentModule } from '@hykr/agents/script';

export const ${n.m}Agent: AgentModule = {
  rules: [],
  scripts: [],
  evalCases: [],
};
`,
    'index.ts': `/** The ${words(n.module)} module, server side. */
import { defineModule } from '@hykr/api';
import { ${n.m}Agent } from './agent/index.js';
import { ${n.m}Spec } from './contracts/index.js';
import * as tables from './db/schema.js';
import { ${n.m}Notifications } from './notifications/index.js';
import { ${pascal(n.module)}Module } from './server/${n.module}.module.js';
import { ${n.m}Views } from './views/index.js';

export const ${n.m} = defineModule({
  ...${n.m}Spec,
  server: ${pascal(n.module)}Module,
  views: ${n.m}Views.views,
  screens: ${n.m}Views.screens,
  templates: ${n.m}Notifications.templates,
  notifications: ${n.m}Notifications.notifications,
  agent: ${n.m}Agent,
  tables,
});
`,
  };
}

/** The app half, by path inside the app's src/. */
function appFiles(n: Names, defineAppModule: boolean): Record<string, string> {
  const views = `${n.domainPackage}/modules/${n.module}/views`;
  const Screen = pascal(n.plural);
  const nav = `[
    {
      href: '/${n.module}',
      label: '${n.Title}',
      icon: 'list',
      match: (path: string) => path.startsWith('/${n.module}'),
    },
  ]`;
  const body = `{
  name: '${n.module}',
  nav: ${nav},
  suggestions: [],
  bind: () => {
    bindView(${n.E}ListView, ${n.E}ListComponent);
  },
}`;
  return {
    [`modules/${n.module}/views.tsx`]: `import { Rows, ViewCard } from '@hykr/app';
import { Text } from '@hykr/app/ui';
import type { ViewProps } from '@hykr/ui-registry/react';
import type { ${n.E}ListView } from '${views}';

export function ${n.E}ListComponent({ title, items, words }: ViewProps<typeof ${n.E}ListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(item) => <Text className="font-semibold">{item.title}</Text>}
      </Rows>
    </ViewCard>
  );
}
`,
    [`modules/${n.module}/index.tsx`]: `/**
 * The ${words(n.module)} module, app side: its destination and its views' components. Other code
 * imports this file only, never a file under it.
 */
${defineAppModule ? "import { defineAppModule } from '@hykr/app';\n" : ''}import { bindView } from '@hykr/ui-registry/react';
import { ${n.E}ListView } from '${views}';
import { ${n.E}ListComponent } from './views';

export const ${n.m} = ${defineAppModule ? `defineAppModule(${body})` : body};
`,
    [`modules/${n.module}/routes.ts`]: `// The ${words(n.module)} module's route components; src/app/${n.module}/ re-exports them.
export { ${Screen} as ${Screen}Route } from './screens/${Screen}';
`,
    [`modules/${n.module}/screens/${Screen}.tsx`]: `import {
  EmptyState,
  LoadError,
  ScreenTitle,
  styles,
  useEntityList,
  useScreenContext,
} from '@hykr/app';
import { FlatList, Text, View } from 'react-native';

/** Every ${n.label}, newest first. */
export function ${Screen}() {
  useScreenContext({ screen: '${n.module}' });
  const list = useEntityList('${n.plural}', { sort: '-createdAt' });
  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={list.items}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={<ScreenTitle title="${n.Title}" />}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <Text>{item.title}</Text>
        </View>
      )}
      ListEmptyComponent={
        list.error ? (
          <LoadError what="${n.label}s" onRetry={list.refresh} />
        ) : list.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : (
          <EmptyState icon="list" title="No ${n.label}s yet" />
        )
      }
      onEndReached={list.loadMore}
    />
  );
}
`,
    [`app/${n.module}/index.tsx`]: `export { ${Screen}Route as default } from '@/modules/${n.module}/routes';
`,
  };
}
