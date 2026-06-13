import { describe, it, expect } from 'vitest';
import { computeNextFire } from './schedule';
import type { ScheduleSpec } from './types';

// Все ожидаемые значения — UTC (московский wall-clock минус 3 часа).

describe('computeNextFire — oneoff', () => {
  const spec: ScheduleSpec = { kind: 'oneoff', at: '2026-06-20T09:00' };

  it('возвращает единственный момент в будущем', () => {
    expect(computeNextFire(spec, '2026-06-01T00:00:00.000Z', 0)).toBe('2026-06-20T06:00:00.000Z');
  });

  it('после срабатывания — null', () => {
    expect(computeNextFire(spec, '2026-06-20T06:00:00.000Z', 1)).toBeNull();
  });
});

describe('computeNextFire — daily', () => {
  const daily = (interval: number): ScheduleSpec => ({
    kind: 'recurring',
    freq: 'daily',
    interval,
    startDate: '2026-06-20',
    time: '09:00',
  });

  it('первое срабатывание', () => {
    expect(computeNextFire(daily(1), '2026-06-19T23:00:00.000Z', 0)).toBe('2026-06-20T06:00:00.000Z');
  });

  it('следующий день', () => {
    expect(computeNextFire(daily(1), '2026-06-20T06:00:00.000Z', 1)).toBe('2026-06-21T06:00:00.000Z');
  });

  it('каждые 3 дня', () => {
    expect(computeNextFire(daily(3), '2026-06-20T06:00:00.000Z', 1)).toBe('2026-06-23T06:00:00.000Z');
  });
});

describe('computeNextFire — weekly (Пн, Ср)', () => {
  // 2026-06-20 — суббота; неделя старта Пн=06-15. Первые валидные: 06-22 (Пн), 06-24 (Ср).
  const spec: ScheduleSpec = {
    kind: 'recurring',
    freq: 'weekly',
    interval: 1,
    startDate: '2026-06-20',
    time: '09:00',
    weekdays: [1, 3],
  };

  it('первый — ближайший понедельник', () => {
    expect(computeNextFire(spec, '2026-06-20T00:00:00.000Z', 0)).toBe('2026-06-22T06:00:00.000Z');
  });

  it('затем среда', () => {
    expect(computeNextFire(spec, '2026-06-22T06:00:00.000Z', 1)).toBe('2026-06-24T06:00:00.000Z');
  });
});

describe('computeNextFire — monthly с клампом', () => {
  const spec: ScheduleSpec = {
    kind: 'recurring',
    freq: 'monthly',
    interval: 1,
    startDate: '2026-01-31',
    time: '12:00',
    monthday: 31,
  };

  it('31-е → конец февраля (28)', () => {
    expect(computeNextFire(spec, '2026-01-31T09:00:00.000Z', 1)).toBe('2026-02-28T09:00:00.000Z');
  });
});

describe('computeNextFire — yearly с клампом 29 фев', () => {
  const spec: ScheduleSpec = {
    kind: 'recurring',
    freq: 'yearly',
    interval: 1,
    startDate: '2024-02-29',
    time: '10:00',
  };

  it('29 фев → 28 фев в невисокосный год', () => {
    expect(computeNextFire(spec, '2024-02-29T07:00:00.000Z', 1)).toBe('2025-02-28T07:00:00.000Z');
  });
});

describe('computeNextFire — окончания', () => {
  const base = { kind: 'recurring', freq: 'daily', interval: 1, startDate: '2026-06-20', time: '09:00' } as const;

  it('afterN: достигнут лимит → null', () => {
    const spec: ScheduleSpec = { ...base, end: { type: 'afterN', n: 2 } };
    expect(computeNextFire(spec, '2026-06-21T06:00:00.000Z', 2)).toBeNull();
    expect(computeNextFire(spec, '2026-06-20T06:00:00.000Z', 1)).toBe('2026-06-21T06:00:00.000Z');
  });

  it('until: за датой → null, до даты → срабатывает', () => {
    const spec: ScheduleSpec = { ...base, end: { type: 'until', until: '2026-06-22' } };
    expect(computeNextFire(spec, '2026-06-21T06:00:00.000Z', 2)).toBe('2026-06-22T06:00:00.000Z');
    expect(computeNextFire(spec, '2026-06-22T06:00:00.000Z', 3)).toBeNull();
  });
});

describe('computeNextFire — daily с далёким якорем (дайджест)', () => {
  const spec: ScheduleSpec = {
    kind: 'recurring',
    freq: 'daily',
    interval: 1,
    startDate: '2020-01-01',
    time: '10:00',
  };

  it('перематывает к настоящему (не упирается в MAX_OCCURRENCES)', () => {
    // 05:00Z = 08:00 МСК 14-го → сегодня 10:00 МСК = 07:00Z.
    expect(computeNextFire(spec, '2026-06-14T05:00:00.000Z', 0)).toBe('2026-06-14T07:00:00.000Z');
  });

  it('после сегодняшнего 10:00 → завтра', () => {
    expect(computeNextFire(spec, '2026-06-14T08:00:00.000Z', 0)).toBe('2026-06-15T07:00:00.000Z');
  });
});

describe('computeNextFire — dates', () => {
  const spec: ScheduleSpec = {
    kind: 'dates',
    dates: ['2026-07-01', '2026-06-25'],
    times: ['09:00', '18:00'],
  };

  it('берёт ближайший момент из набора дат×времён', () => {
    expect(computeNextFire(spec, '2026-06-25T10:00:00.000Z', 0)).toBe('2026-06-25T15:00:00.000Z');
  });
});
