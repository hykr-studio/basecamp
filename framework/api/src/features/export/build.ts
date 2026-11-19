// What an export reads and how it is written: every entity the process serves, read as the
// person it is for (their access, grants and hidden fields), and every export source, each as
// JSON and CSV in one zip archive with its manifest. Nothing here loads Nest.
import {
  type Catalog,
  type ExportFormat,
  type ExportManifest,
  type ExportOutput,
  type ExportPart,
  type ExportSkipped,
  type GatedOff,
  type ListQuery,
  listInputSchema,
  type Principal,
} from '@hykr/contracts';
import { type AnyEntityDef, entityDefs, projectRead, toJson } from '@hykr/core';
import type { Database } from '@hykr/db';
import type { Type } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { z } from 'zod';
import { entityOff } from '../settings/gates.js';
import { csvOf, exportColumns, jsonOf } from './csv.js';
import { type DataExportSource, dataExportSources } from './sources.js';
import { ZipWriter } from './zip.js';

type Values = Record<string, unknown>;

/** Rows read per page. */
const PAGE = 500;

/** What an export reads, and what it leaves out and why. */
export interface ExportPlan {
  entities: readonly AnyEntityDef[];
  sources: readonly DataExportSource[];
  skipped: ExportSkipped[];
}

/** Every entity, then every source, as `only` names them. */
const byPlural = () => [...entityDefs()].sort((a, b) => a.plural.localeCompare(b.plural));

/** The names in `only` that are no entity and no export source. */
export function unknownParts(only: readonly string[] | undefined): string[] {
  if (!only) return [];
  const known = new Set([
    ...entityDefs().map((d) => d.name),
    ...dataExportSources.all().map((s) => s.name),
  ]);
  return [...new Set(only)].filter((n) => !known.has(n));
}

/**
 * The parts of an export: the entities people can list (not `internal`) that are on for the
 * business, and the export sources, narrowed to `only` when given.
 */
export function planExport(
  only: readonly string[] | undefined,
  off: GatedOff,
  catalog: Catalog,
): ExportPlan {
  const wanted = (name: string) => !only || only.includes(name);
  const skipped: ExportSkipped[] = [];
  const entities: AnyEntityDef[] = [];
  for (const def of byPlural()) {
    if (!wanted(def.name)) continue;
    if (def.spec.expose.list === 'internal') skipped.push({ name: def.name, reason: 'not_listed' });
    else if (entityOff(off, catalog, def.name))
      skipped.push({ name: def.name, reason: 'switched_off' });
    else entities.push(def);
  }
  const sources = dataExportSources.all().filter((s) => wanted(s.name));
  return { entities, sources, skipped };
}

/** The archive would be larger than one stored file may be. */
export class ExportTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`The export is larger than the ${maxBytes} bytes one file may hold here`);
  }
}

/** The plugins of this entity refuse this person's list (a sort on a field hidden from them). */
class ListRefused extends Error {}

/** Every row of one entity p reaches, as p may see it; rows of no other business. */
async function entityRows(
  def: AnyEntityDef,
  p: Principal,
  db: Database,
  signal: AbortSignal,
): Promise<Values[]> {
  const rows: Values[] = [];
  let cursor: string | undefined;
  do {
    if (signal.aborted) throw new Error('The export ran out of time');
    const q = listInputSchema(def.spec, { maxLimit: PAGE }).parse({
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
    }) as ListQuery;
    // As GET /api/<plural>: a plugin may refuse the list itself.
    try {
      for (const x of def.plugins()) x.query?.(q, p, { spec: def.spec, table: def.table });
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === 403) throw new ListRefused();
      throw e;
    }
    const page = await def.repo.list(db, p, q);
    for (const row of page.items) {
      // A platform-shared row is readable, but it is not this business's data.
      if ((row as { tenantId?: unknown }).tenantId !== p.tenantId) continue;
      rows.push(def.toRead(row, p) as Values);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

/** The read schema's fields, in order. */
const schemaKeys = (def: AnyEntityDef) =>
  Object.keys((def.spec.schemas.read as z.ZodObject).shape ?? {});

/**
 * The CSV columns for an entity: those its rows have. With no rows, the read schema's fields
 * that survive p's projection, so a hidden field's name is not in the header either.
 */
function entityColumns(def: AnyEntityDef, rows: readonly Values[], p: Principal): string[] {
  const keys = schemaKeys(def);
  if (rows.length) return exportColumns(rows, keys);
  try {
    const probe = def.project(Object.fromEntries(keys.map((k) => [k, null])), p);
    return keys.filter((k) => k in probe);
  } catch {
    return [];
  }
}

/** Every row a source yields, JSON-ready and through the read projectors. */
async function sourceRows(
  source: DataExportSource,
  a: Pick<BuildArgs, 'principal' | 'tenantId' | 'db' | 'signal' | 'get'>,
): Promise<Values[]> {
  const yielded = source.rows({
    principal: a.principal,
    tenantId: a.tenantId,
    db: a.db,
    signal: a.signal,
    get: a.get,
  });
  const raw: Values[] = [];
  if (Symbol.asyncIterator in yielded) {
    for await (const row of yielded as AsyncIterable<Values>) {
      if (a.signal.aborted) throw new Error('The export ran out of time');
      raw.push(row);
    }
  } else raw.push(...(await yielded));
  return raw.map((row) => projectRead(source.name, toJson(row) as Values, a.principal));
}

export interface BuildArgs {
  /** Whom the export is for: everything is read as them. */
  principal: Principal;
  tenantId: string;
  db: Database;
  formats: readonly ExportFormat[];
  plan: ExportPlan;
  catalog: Catalog;
  /** The archive may not be larger (one stored file's cap). */
  maxBytes: number;
  signal: AbortSignal;
  /** When the export was made: the manifest's `exportedAt` and the archive's dates. */
  at: Date;
  progress(percent: number, message: string): Promise<void>;
  get<T>(token: Type<T> | string | symbol): T;
}

/** The archive, its manifest and the job's output. Throws `ExportTooLarge` past `maxBytes`. */
export async function buildExport(
  a: BuildArgs,
): Promise<{ archive: Buffer; manifest: ExportManifest; output: ExportOutput }> {
  const zip = new ZipWriter(a.at);
  const parts: ExportPart[] = [];
  const skipped = [...a.plan.skipped];
  const total = a.plan.entities.length + a.plan.sources.length;
  let done = 0;

  const write = (base: string, rows: readonly Values[], columns: readonly string[]) => {
    const files: string[] = [];
    if (a.formats.includes('json')) {
      zip.add(`${base}.json`, jsonOf(rows));
      files.push(`${base}.json`);
    }
    if (a.formats.includes('csv')) {
      zip.add(`${base}.csv`, csvOf(rows, columns));
      files.push(`${base}.csv`);
    }
    if (zip.size > a.maxBytes) throw new ExportTooLarge(a.maxBytes);
    return files;
  };
  const step = async (name: string) => {
    await a.progress(Math.floor((90 * done) / Math.max(1, total)), `Exporting ${name}`);
    done += 1;
  };

  for (const def of a.plan.entities) {
    await step(def.plural);
    let rows: Values[];
    try {
      rows = await entityRows(def, a.principal, a.db, a.signal);
    } catch (e) {
      if (!(e instanceof ListRefused)) throw e;
      skipped.push({ name: def.name, reason: 'refused' });
      continue;
    }
    const files = write(def.plural, rows, entityColumns(def, rows, a.principal));
    parts.push({
      name: def.name,
      kind: 'entity',
      module: a.catalog.moduleOf(def.name) ?? null,
      label: def.spec.label,
      rows: rows.length,
      files,
    });
  }
  for (const source of a.plan.sources) {
    await step(source.name);
    const rows = await sourceRows(source, a);
    const files = write(source.name, rows, exportColumns(rows, []));
    parts.push({
      name: source.name,
      kind: 'source',
      module: null,
      label: source.name,
      rows: rows.length,
      files,
    });
  }

  const manifest: ExportManifest = {
    version: 1,
    tenantId: a.tenantId,
    exportedAt: a.at.toISOString(),
    exportedBy: { kind: a.principal.actor.kind, id: a.principal.actor.id },
    formats: [...a.formats],
    parts,
    skipped,
  };
  zip.add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const archive = zip.finish();
  if (archive.length > a.maxBytes) throw new ExportTooLarge(a.maxBytes);
  return {
    archive,
    manifest,
    output: {
      rows: parts.reduce((n, x) => n + x.rows, 0),
      bytes: archive.length,
      formats: [...a.formats],
      parts: parts.map(({ files: _files, ...rest }) => rest),
      skipped,
    },
  };
}
