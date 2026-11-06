import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// The .env files, into this process (Vitest's main process), nearest first: the application's
// root, then the repository's above it. Nothing already set is overridden (loadEnv puts
// process.env over the file), so the shell and CI win, then the nearer file.
for (const dir of ['..', '../..']) Object.assign(process.env, loadEnv('test', dir, ''));

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
      // Files in this process's memory: no object store needed.
      STORAGE_DRIVER: 'memory',
    },
  },
});
