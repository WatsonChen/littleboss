import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Stopgap until Google sign-in: one shared access token from the server environment.
 * With no token configured the API is open only outside production; in production it refuses
 * everything rather than run without a lock.
 */
export function createAuthHook(env: Record<string, string | undefined>) {
  const token = env.ACCESS_TOKEN?.trim();
  const production = env.NODE_ENV === 'production' || Boolean(env.VERCEL_ENV);
  return async function auth(req: FastifyRequest) {
    if (!token) {
      if (production) {
        throw new HttpError(503, 'auth_not_configured', 'Access is not set up on the server yet.');
      }
      return;
    }
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!timingSafeEqual(digest(given), digest(token))) {
      throw new HttpError(401, 'unauthorized', 'Missing or wrong access token.');
    }
  };
}
