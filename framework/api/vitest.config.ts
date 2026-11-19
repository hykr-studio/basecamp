import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
// From the build, like everything the tests run.
import { workerCount } from './dist/testing-workers.js';

// The repo's .env, into this process. The config runs in Vitest's main process, where
// globalSetup migrates, so the migrations and the tests use the same database. Nothing already
// set is overridden (loadEnv puts process.env over the file): in CI the workflow's env wins.
Object.assign(process.env, loadEnv('test', '../..', ''));

// How many files at once (TEST_WORKERS; one per processor up to four).
const workers = workerCount();

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Files side by side, each worker with its own database and Redis keys (test/worker.ts);
    // TEST_WORKERS=1 runs them one after another on DATABASE_URL itself.
    fileParallelism: workers > 1,
    maxWorkers: workers,
    setupFiles: ['test/worker.ts'],
    env: {
      ...process.env,
      // Always the scripted model: tests need no key and cost nothing.
      MODEL_MODE: 'fake',
      GUARDRAILS: 'off',
      THROTTLE: 'off',
      // Queue jobs run inside the test app, under their own keys in Redis.
      WORKER_INLINE: '1',
      BULL_PREFIX: `test-${Date.now()}`,
      // Files in this process's memory: no object store needed.
      STORAGE_DRIVER: 'memory',
      // Documents drawn by the fake engine: plain text lines, fast and searchable.
      DOCUMENTS_ENGINE: 'fake',
    },
  },
});
