import { describe, expect, it } from 'vitest';
import {
  formatPublishAt,
  missingForHandoff,
  nextStep,
  pasteablePublishAt,
  progressLabel,
} from './flows';

const step = (key: string, status: 'todo' | 'done') => ({
  key,
  kind: 'manual' as const,
  title: key,
  help: '',
  status,
  link: null,
});

describe('flow helpers', () => {
  it('shows a publishing time with its weekday', () => {
    expect(formatPublishAt('2026-10-22T18:00')).toBe('10/22（週四）18:00');
    expect(formatPublishAt('2026-11-02T07:05')).toBe('11/2（週一）07:05');
    expect(formatPublishAt('nonsense')).toBe('nonsense');
  });
  it('writes the time the way a podcast host form wants it', () => {
    expect(pasteablePublishAt('2026-10-22T18:00')).toBe('2026/10/22 18:00');
  });
  it('counts progress and finds the next step', () => {
    const flow = { steps: [step('a', 'done'), step('b', 'todo'), step('c', 'todo')] };
    expect(progressLabel(flow)).toBe('1/3');
    expect(nextStep(flow)?.key).toBe('b');
    expect(nextStep({ steps: [step('a', 'done')] })).toBeNull();
  });
  it('says what is missing before the paste screen is useful', () => {
    expect(missingForHandoff({ chosen: null, publishAt: null })).toEqual([
      '標題與描述',
      '發佈時間',
    ]);
    expect(
      missingForHandoff({ chosen: { title: 't', description: 'd' }, publishAt: null }),
    ).toEqual(['發佈時間']);
    expect(
      missingForHandoff({
        chosen: { title: 't', description: 'd' },
        publishAt: '2026-10-22T18:00',
      }),
    ).toEqual([]);
  });
});
