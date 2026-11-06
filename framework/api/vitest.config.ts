import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// The repo's .env, into this process. The config runs in Vitest's main process, where
// globalSetup migrates, so the migrations and the tests use the same database. Nothing already
// set is overridden (loadEnv puts process.env over the file): in CI the workflow's env wins.
Object.assign(process.env, loadEnv('test', '../..', ''));

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One app, one database: run files one after another.
    fileParallelism: false,
    env: {
      ...process.env,
      // Always the scripted model: tests need no key and cost nothing.
      MODEL_MODE: 'fake',
      GUARDRAILS: 'off',
      THROTTLE: 'off',
      // Queue jobs run inside the test app, under their own keys in Redis.
      WORKER_INLINE: '1',
      BULL_PREFIX: `test-${Date.now()}`,
    },
  },
});
