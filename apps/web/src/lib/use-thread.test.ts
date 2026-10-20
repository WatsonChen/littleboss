import { describe, expect, it } from 'vitest';
import type { MessageView } from '@littleboss/shared';
import { chainMayContinue } from './use-thread';

const msg = (over: Partial<MessageView>): MessageView =>
  ({
    id: 'm',
    role: 'agent',
    status: 'succeeded',
    autoKind: 'discussion',
    finishedAt: new Date(1_000_000).toISOString(),
    ...over,
  }) as MessageView;

describe('chainMayContinue', () => {
  it('keeps watching for a few seconds after a discussion turn finished', () => {
    expect(chainMayContinue([msg({})], 1_005_000)).toBe(true);
  });
  it('gives up after the grace period', () => {
    expect(chainMayContinue([msg({})], 1_020_000)).toBe(false);
  });
  it('does not wait after a summary, a review, a plain reply or a failure', () => {
    expect(chainMayContinue([msg({ autoKind: 'summary' })], 1_001_000)).toBe(false);
    expect(chainMayContinue([msg({ autoKind: 'review' })], 1_001_000)).toBe(false);
    expect(chainMayContinue([msg({ autoKind: null })], 1_001_000)).toBe(false);
    expect(chainMayContinue([msg({ status: 'failed' })], 1_001_000)).toBe(false);
    expect(chainMayContinue([], 1_001_000)).toBe(false);
  });
});
