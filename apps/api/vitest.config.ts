import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files that use the database share one test database and clear its tables, so they
    // must not run at the same time.
    fileParallelism: false,
  },
});
