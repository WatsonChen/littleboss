import { defineNitroConfig } from 'nitro/config';

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  plugins: ['plugins/start-pg-world.ts'],
  vercel: { entryFormat: 'node' },
  routes: { '/**': { handler: './src/index.ts', format: 'node' } },
});
