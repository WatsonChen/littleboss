import { z } from 'zod';

/** Contracts shared by apps/web and apps/api. Types, validation and enums only — no runtime logic. */

export const HealthResponse = z.object({
  ok: z.literal(true),
  service: z.literal('littleboss-api'),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export { CallStatus } from './call-status.js';
export * from './discussion.js';
export * from './runs.js';
export * from './captures.js';
