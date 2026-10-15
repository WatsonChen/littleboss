import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { dedupe: ['vitest'] },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
