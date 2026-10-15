import { buildApp } from './app.js';

// Local / long-running entry. On Vercel the platform uses src/server.ts instead.
const port = Number(process.env.PORT ?? 8787);
const app = buildApp();

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
