import { ExternalAmbiguousError, ExternalRejectedError } from './errors.js';
import type { ExternalClient } from './external-action.js';

export type FakeMode =
  | 'ok'
  | 'reject'
  /** Processed successfully, but the response never reaches the caller. */
  | 'ok_response_lost'
  /** Request lost before processing: no effect happened. */
  | 'lost_before_processing';

/** Test double for an external write target (stands in for Google Calendar in M0). */
export class FakeExternalService implements ExternalClient {
  mode: FakeMode = 'ok';
  writeCalls = 0;
  private records = new Map<string, { externalId: string; payload: unknown }>();

  /** Number of distinct real-world effects. Must be at most 1 per idempotency key. */
  get effects(): number {
    return this.records.size;
  }

  async write(idempotencyKey: string, payload: unknown) {
    this.writeCalls += 1;
    if (this.mode === 'reject') throw new ExternalRejectedError('rejected by fake service');
    if (this.mode === 'lost_before_processing') {
      throw new ExternalAmbiguousError('timeout before processing');
    }

    let record = this.records.get(idempotencyKey);
    if (!record) {
      record = { externalId: `ext_${this.records.size + 1}`, payload };
      this.records.set(idempotencyKey, record);
    }
    if (this.mode === 'ok_response_lost') {
      throw new ExternalAmbiguousError('connection reset after processing');
    }
    return { externalId: record.externalId };
  }

  async lookup(idempotencyKey: string) {
    const record = this.records.get(idempotencyKey);
    return record ? { externalId: record.externalId } : null;
  }
}
