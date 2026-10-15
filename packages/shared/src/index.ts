import { z } from 'zod';

/** Contracts shared by apps/web and apps/api. Types, validation and enums only — no runtime logic. */

export const HealthResponse = z.object({
  ok: z.literal(true),
  service: z.literal('littleboss-api'),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** Status of one model call (M1). Kept here so web and api agree on the vocabulary. */
export const CallStatus = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'bad_format',
]);
export type CallStatus = z.infer<typeof CallStatus>;
