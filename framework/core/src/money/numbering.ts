import {
  createHookRegistry,
  formatNumber,
  type NumberSeriesDef,
  numberPeriod,
  type Principal,
} from '@hykr/contracts';
import { takeNumber } from '@hykr/db';
import { tenantOf } from '../entity/define-entity.js';
import type { Tx } from '../tokens.js';
import { tenantMoney } from './tenant-money.js';

declare module '@hykr/contracts' {
  interface Contributions {
    numberSeries: readonly NumberSeriesDef[];
  }
}

/** The application's number series (`contributes: { numberSeries }`), by name. */
export const numberSeries = createHookRegistry<NumberSeriesDef>('number series', (s) => s.name, {
  collects: 'numberSeries',
});

/** A number taken: as people read it, its place in the series, and the counter it came from. */
export interface TakenNumber {
  number: string;
  seq: number;
  period: string;
}

/**
 * The next number of a series for the principal's business, taken in the write's transaction:
 * gapless, because a write that rolls back gives it back, and a write that waits for approval
 * takes none until it runs. Call it from a command's `run`. The series must be registered, and
 * its period follows the business's time zone and financial-year start.
 */
export async function nextNumber(
  tx: Tx,
  p: Principal,
  series: NumberSeriesDef | string,
  at: Date = new Date(),
): Promise<TakenNumber> {
  const name = typeof series === 'string' ? series : series.name;
  const def = numberSeries.get(name);
  if (!def)
    throw new Error(`Number series "${name}" is not registered (contributes: { numberSeries })`);
  if (typeof series !== 'string' && (def.format !== series.format || def.reset !== series.reset))
    throw new Error(`Number series "${name}" is registered with another format or reset`);
  const tenantId = tenantOf(p);
  const settings = await tenantMoney(tx, tenantId);
  const period = numberPeriod(def, at, settings);
  const seq = await takeNumber(tx, { tenantId, series: def.name, period });
  return { number: formatNumber(def, seq, at, settings), seq, period };
}
