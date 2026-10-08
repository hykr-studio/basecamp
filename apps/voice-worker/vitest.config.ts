import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      ...loadEnv('test', '../..', ''),
      ...process.env,
      MODEL_MODE: 'fake',
      GUARDRAILS: 'off',
      THROTTLE: 'off',
    },
  },
});
