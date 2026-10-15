import { describe, expect, it } from 'vitest';
import { CallStatus, HealthResponse } from './index';

describe('shared contracts', () => {
  it('accepts a valid health response', () => {
    const parsed = HealthResponse.safeParse({
      ok: true,
      service: 'littleboss-api',
      time: new Date().toISOString(),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown call status', () => {
    expect(CallStatus.safeParse('done').success).toBe(false);
    expect(CallStatus.safeParse('timed_out').success).toBe(true);
  });
});
