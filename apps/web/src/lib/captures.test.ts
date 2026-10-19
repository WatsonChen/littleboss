import { describe, expect, it } from 'vitest';
import { formatWhen, itemStatusLabel, toLocalInput, toOffsetString } from './captures';

describe('capture time helpers', () => {
  it('adds the zone offset to a typed date-time', () => {
    expect(toOffsetString('2026-10-20T15:00', 'Asia/Taipei')).toBe('2026-10-20T15:00:00+08:00');
    expect(toOffsetString('2026-01-15T09:30', 'America/New_York')).toBe(
      '2026-01-15T09:30:00-05:00',
    );
    expect(toOffsetString('2026-07-15T09:30', 'America/New_York')).toBe(
      '2026-07-15T09:30:00-04:00',
    );
  });
  it('refuses anything that is not a date-time', () => {
    expect(toOffsetString('', 'Asia/Taipei')).toBeNull();
    expect(toOffsetString('2026-10-20', 'Asia/Taipei')).toBeNull();
    expect(toOffsetString('2026-13-45T99:99', 'Asia/Taipei')).toBeNull();
  });
  it('shows the wall-clock time without shifting zones', () => {
    expect(toLocalInput('2026-10-20T15:00:00+08:00')).toBe('2026-10-20T15:00');
    expect(toLocalInput(null)).toBe('');
    expect(formatWhen('2026-10-20T15:00:00+08:00', false)).toBe('10/20（二） 15:00');
    expect(formatWhen('2026-10-20', true)).toBe('10/20（二） 全天');
    expect(formatWhen(null, false)).toBe('時間未定');
  });
  it('labels every status', () => {
    expect(itemStatusLabel('needs_info')).toBe('還缺資料');
  });
});
