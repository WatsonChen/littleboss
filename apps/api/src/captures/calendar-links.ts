import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

type Env = Record<string, string | undefined>;

/**
 * Calendar apps cannot send our access token, so their links carry a signature instead. It is an
 * HMAC of what the link opens, keyed with the server's access token: nobody can make one without
 * the token, and a leaked link only opens the one thing it was made for.
 */
const sign = (env: Env, what: string) =>
  createHmac('sha256', env.ACCESS_TOKEN?.trim() || 'littleboss-dev-only')
    .update(what)
    .digest('hex')
    .slice(0, 32);

export const eventSignature = (env: Env, itemId: string) => sign(env, `ics-event:${itemId}`);
export const feedToken = (env: Env) => sign(env, 'ics-feed');

export function sameSignature(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** This server's public address, as the caller reached it (behind Vercel's proxy). */
export function baseUrlOf(req: FastifyRequest): string {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0];
  const proto = first(req.headers['x-forwarded-proto']) ?? req.protocol;
  const host = first(req.headers['x-forwarded-host']) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}
