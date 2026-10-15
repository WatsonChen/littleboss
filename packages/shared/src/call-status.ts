import { z } from 'zod';

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
