import { describe, expect, it } from 'vitest';
import { isRunActive, needsPerson, outcomeText, runStateLabel } from './runs';

describe('run labels', () => {
  it('tells waiting-on-you apart from working and finished', () => {
    expect(needsPerson({ state: 'waiting_input' })).toBe(true);
    expect(needsPerson({ state: 'waiting_approval' })).toBe(true);
    expect(needsPerson({ state: 'running' })).toBe(false);
    expect(isRunActive({ state: 'running' })).toBe(true);
    expect(isRunActive({ state: 'succeeded' })).toBe(false);
    expect(runStateLabel('waiting_approval')).toBe('等你核准');
  });

  it('explains failures in plain words and falls back to the server reason', () => {
    expect(outcomeText({ status: 'failed', code: 'truncated', reason: 'x' })).toContain('截斷');
    expect(outcomeText({ status: 'failed', code: 'weird', reason: 'server said so' })).toBe('server said so');
    expect(outcomeText({ status: 'rejected' })).toContain('沒有存');
    expect(outcomeText(null)).toBeNull();
  });
});
