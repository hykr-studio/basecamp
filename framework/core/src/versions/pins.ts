// Approval pins (B4): what a parked write loaded must still be as it was when the write is
// approved. The entity plugins say what to keep (`onPark`, a version) and how to compare
// (`onReplay`); the parked operation carries the pins in its `args`, which the approval stores
// and hands back to the operation on the replay. docs/decisions/B6B4.md.
import { revisionFields, versionedOf, versionField } from '@hykr/contracts';
import { ConflictException } from '@nestjs/common';
import type { AnyEntityDef } from '../entity/define-entity.js';

type Values = Record<string, unknown>;

/** A record a write loaded, and the entity it belongs to. */
export interface PinTarget {
  def: AnyEntityDef;
  row: Values | null | undefined;
}

/** What each record's plugins pinned, by '<entity>:<id>'. */
export type Pins = Record<string, Values>;

const keyOf = (t: PinTarget) => `${t.def.name}:${String((t.row as Values).id)}`;

/** The pins of the records a write loaded; undefined when no plugin pins anything. */
export function pinsOf(targets: readonly PinTarget[]): Pins | undefined {
  const out: Pins = {};
  for (const t of targets) {
    if (!t.row) continue;
    const target = { spec: t.def.spec, table: t.def.table };
    let pinned: Values | undefined;
    for (const x of t.def.plugins()) {
      const v = x.onPark?.(t.row, target);
      if (v) pinned = { ...pinned, ...v };
    }
    if (pinned) out[keyOf(t)] = pinned;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * On an approved replay: each record against what was pinned when the request was made. A
 * record that moved on refuses the replay (409), so an approval is never applied to a version
 * nobody approved. A record no longer loaded is the operation's own concern (its load 404s).
 */
export function checkPins(targets: readonly PinTarget[], pins: Pins): void {
  for (const t of targets) {
    if (!t.row) continue;
    const pinned = pins[keyOf(t)];
    if (!pinned) continue;
    const target = { spec: t.def.spec, table: t.def.table };
    for (const x of t.def.plugins()) {
      const stale = x.onReplay?.(t.row, pinned, target);
      if (stale) throw new ConflictException(stale);
    }
  }
}

/**
 * A record's version as people read it: "v2, edit 4" (its revision, and how many times that one
 * was written), or "version 4" without revisions. Empty when unversioned.
 */
export function versionNote(def: AnyEntityDef, row: Values | null | undefined): string {
  const trait = versionedOf(def.spec);
  if (!trait || !row) return '';
  const version = row[versionField(trait)];
  const rev = revisionFields(trait);
  const revision = rev ? row[rev.number] : undefined;
  return revision !== undefined && revision !== null
    ? `v${revision}, edit ${version}`
    : `version ${version}`;
}
