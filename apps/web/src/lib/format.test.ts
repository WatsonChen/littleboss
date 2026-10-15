import { describe, expect, it } from 'vitest';
import { formatUsd, isStuck, messageCostLabel } from './format';

describe('format', () => {
  it('shows small amounts with enough digits, never as zero', () => {
    expect(formatUsd(0)).toBe('US$0');
    expect(formatUsd(1234)).toBe('US$0.0012');
    expect(formatUsd(123_456)).toBe('US$0.123');
  });
  it('labels an estimate as an estimate and a real cost as plain', () => {
    expect(
      messageCostLabel({ costMicro: null, estimatedCostMicro: 5000, costIsEstimate: true }),
    ).toBe('約 US$0.0050（估算）');
    expect(
      messageCostLabel({ costMicro: 5000, estimatedCostMicro: 9000, costIsEstimate: false }),
    ).toBe('US$0.0050');
    expect(
      messageCostLabel({ costMicro: null, estimatedCostMicro: null, costIsEstimate: true }),
    ).toBeNull();
  });
  it('flags calls that have waited or run too long', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    expect(
      isStuck({ status: 'queued', queuedAt: '2026-10-15T11:58:00Z', startedAt: null }, now),
    ).toBe(true);
    expect(
      isStuck({ status: 'queued', queuedAt: '2026-10-15T11:59:30Z', startedAt: null }, now),
    ).toBe(false);
    expect(
      isStuck({ status: 'running', queuedAt: null, startedAt: '2026-10-15T11:50:00Z' }, now),
    ).toBe(true);
    expect(isStuck({ status: 'succeeded', queuedAt: null, startedAt: null }, now)).toBe(false);
  });
});
