// `basecamp import <entity> <file>`: its options, read from the command line. The server
// checks them again (ImportOptions in @hykr/contracts); here only their shape.

/** What the command line gives `runImport` (@hykr/api). */
export interface ImportArgs {
  entity: string;
  path: string;
  as: string;
  tenant?: string;
  dryRun: boolean;
  key?: string;
  source?: string;
  format?: 'csv' | 'json' | 'ndjson';
  existing?: 'update' | 'skip';
  empty?: 'omit' | 'null';
  /** File column → field, or null to leave the column out. */
  columns?: Record<string, string | null>;
  /** Field → the entity whose keys it holds. */
  refs?: Record<string, string>;
  report?: string;
}

/** The raw values parseArgs returns for the import's options. */
export interface ImportFlags {
  as?: string;
  tenant?: string;
  'dry-run'?: boolean;
  key?: string;
  source?: string;
  format?: string;
  existing?: string;
  empty?: string;
  map?: string[];
  ref?: string[];
  report?: string;
}

/** The options `basecamp import` takes (for parseArgs). */
export const IMPORT_OPTIONS = {
  as: { type: 'string' },
  tenant: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  key: { type: 'string' },
  source: { type: 'string' },
  format: { type: 'string' },
  existing: { type: 'string' },
  empty: { type: 'string' },
  map: { type: 'string', multiple: true },
  ref: { type: 'string', multiple: true },
  report: { type: 'string' },
} as const;

export const IMPORT_USAGE =
  'import <entity> <file> --as <email> [--tenant <id>] [--dry-run] [--key <column>] [--source <name>] [--format csv|json|ndjson] [--existing update|skip] [--empty omit|null] [--map <column>=<field>] [--ref <field>=<entity>] [--report <path>]';

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]) {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T))
    throw new Error(`--${name} is one of ${allowed.join(', ')}, not "${value}"`);
  return value as T;
}

/** `a=b` pairs; `--map old=` (nothing after =) leaves the column out. */
function pairs(name: string, values: readonly string[] | undefined, allowEmpty: boolean) {
  if (!values?.length) return undefined;
  const out: Record<string, string | null> = {};
  for (const v of values) {
    const at = v.indexOf('=');
    const left = at > 0 ? v.slice(0, at).trim() : '';
    const right = at > 0 ? v.slice(at + 1).trim() : '';
    if (!left || (!right && !allowEmpty))
      throw new Error(`--${name} takes <name>=<name>, not "${v}"`);
    out[left] = right || null;
  }
  return out;
}

/** The import's options from `basecamp import <entity> <file> ...`. Throws on a mistake. */
export function importArgs(positionals: readonly string[], flags: ImportFlags): ImportArgs {
  const [entity, path] = positionals;
  if (!entity || !path) throw new Error(`usage: basecamp ${IMPORT_USAGE}`);
  if (!flags.as) throw new Error('--as <email> names the member the records are imported as');
  const refs = pairs('ref', flags.ref, false) as Record<string, string> | undefined;
  return {
    entity,
    path,
    as: flags.as,
    ...(flags.tenant ? { tenant: flags.tenant } : {}),
    dryRun: flags['dry-run'] ?? false,
    ...(flags.key ? { key: flags.key } : {}),
    ...(flags.source ? { source: flags.source } : {}),
    ...(flags.format ? { format: oneOf('format', flags.format, ['csv', 'json', 'ndjson']) } : {}),
    ...(flags.existing ? { existing: oneOf('existing', flags.existing, ['update', 'skip']) } : {}),
    ...(flags.empty ? { empty: oneOf('empty', flags.empty, ['omit', 'null']) } : {}),
    ...(flags.map?.length ? { columns: pairs('map', flags.map, true) } : {}),
    ...(refs ? { refs } : {}),
    ...(flags.report ? { report: flags.report } : {}),
  };
}
