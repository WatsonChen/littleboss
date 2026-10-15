import { ExternalAmbiguousError, ExternalRejectedError } from './errors.js';

export interface ExternalClient {
  /** Must be idempotent on `idempotencyKey`: the same key never produces a second effect. */
  write(idempotencyKey: string, payload: unknown): Promise<{ externalId: string }>;
  /** Look up the result of an earlier write by its idempotency key. */
  lookup(idempotencyKey: string): Promise<{ externalId: string } | null>;
}

export type ExternalActionResult =
  | { status: 'succeeded'; externalId: string; verified: boolean }
  | { status: 'failed'; reason: string }
  /** Outcome could not be determined. Never auto-resend; a person decides. */
  | { status: 'unknown'; reason: string };

/**
 * Run one external write with the M0 rules:
 * - the same idempotency key is used for every attempt, so a retry after a crash cannot duplicate;
 * - when the outcome is ambiguous, verify first; only if verification finds nothing do we stop at
 *   "unknown" instead of resending blindly.
 */
export async function executeExternalAction(
  client: ExternalClient,
  input: { idempotencyKey: string; payload: unknown },
): Promise<ExternalActionResult> {
  try {
    const { externalId } = await client.write(input.idempotencyKey, input.payload);
    return { status: 'succeeded', externalId, verified: false };
  } catch (err) {
    if (err instanceof ExternalRejectedError) {
      return { status: 'failed', reason: err.message };
    }
    if (!(err instanceof ExternalAmbiguousError)) throw err;

    try {
      const found = await client.lookup(input.idempotencyKey);
      if (found) return { status: 'succeeded', externalId: found.externalId, verified: true };
      return { status: 'unknown', reason: `no record found after: ${err.message}` };
    } catch (lookupErr) {
      const msg = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
      return { status: 'unknown', reason: `verification failed (${msg}) after: ${err.message}` };
    }
  }
}
