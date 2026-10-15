import { buildApp } from './build-app.js';

// Vercel invokes the exported Fastify app itself; it must not call listen().
export default buildApp();
