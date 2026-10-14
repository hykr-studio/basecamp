import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One app, one database: run files one after another.
    fileParallelism: false,
    env: {
      // The nearest .env (the application's root, or the repository's above it); in CI the
      // workflow's env wins (loadEnv never overrides it).
      ...loadEnv('test', '../..', ''),
      ...loadEnv('test', '..', ''),
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
