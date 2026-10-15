import { buildApp } from './app.js';

// Vercel invokes the exported Fastify app itself; it must not call listen().
export default buildApp();
