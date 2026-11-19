const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
};

export interface ImportsConfig {
  /** Data rows a file may hold. More: the import fails before writing anything. */
  maxRows: number;
  /** Rows per transaction. */
  batchSize: number;
  /** Rows the error report lists at most. */
  reportRows: number;
  /** How long an import may take, start to finish, in milliseconds. */
  timeoutMs: number;
}

/**
 * The imports feature's limits, from the environment (technical defaults, per deployment):
 * - `IMPORTS_MAX_ROWS` (50 000), `IMPORTS_BATCH_SIZE` (100, at most 1000),
 *   `IMPORTS_REPORT_ROWS` (10 000), `IMPORTS_TIMEOUT_S` (14 400: four hours).
 */
export function importsConfig(env: NodeJS.ProcessEnv = process.env): ImportsConfig {
  return {
    maxRows: num(env.IMPORTS_MAX_ROWS, 50_000),
    batchSize: Math.min(num(env.IMPORTS_BATCH_SIZE, 100), 1000),
    reportRows: num(env.IMPORTS_REPORT_ROWS, 10_000),
    timeoutMs: num(env.IMPORTS_TIMEOUT_S, 14_400) * 1000,
  };
}
