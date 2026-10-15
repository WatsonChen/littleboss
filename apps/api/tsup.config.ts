import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  // packages/shared ships TypeScript source, so it must be bundled into the server output.
  noExternal: ['@littleboss/shared'],
});
