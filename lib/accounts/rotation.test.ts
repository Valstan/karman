import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_WINDOW_HOURS,
  ACTIVATION_WINDOW_MS,
  aggregateUsage,
  availableAt,
  isSpent,
  moscowToday,
  sortAccounts,
  type AccountRotationRow,
} from '@/lib/accounts/rotation';

function row(over: Partial<AccountRotationRow> & { id: number }): AccountRotationRow {
  return {
    title: '',
    email: `acc${over.id}@example.test`,
    usedOn: null,
    usedAt: null,
    projectId: null,
    projectName: null,
    lastTokens: 0,
    ...over,
  };
}

describe('мультиаккаунт: окно активации — 24 часа с момента', () => {
  it('московская дата — по UTC+3, а не по времени машины', () => {
    // 2026-11-02T21:30Z — это уже 3 ноября в Москве (UTC+3).
    expect(moscowToday(new Date('2026-11-02T21:30:00Z'))).toBe('2026-11-03');
    // За час до полуночи по Москве ещё 2-е.
    expect(moscowToday(new Date('2026-11-02T20:59:00Z'))).toBe('2026-11-02');
  });

  it('окно ровно 24 часа со момента активации', () => {
    expect(ACTIVATION_WINDOW_HOURS).toBe(24);
    expect(ACTIVATION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('через 23 часа 59 минут аккаунт ещё израсходован', () => {
    const usedAt = '2026-11-03T10:00:00Z';
    const now = new Date(new Date(usedAt).getTime() + ACTIVATION_WINDOW_MS - 60_000);
    expect(isSpent({ usedAt }, now)).toBe(true);
  });

  it('на исходе 24 часов аккаунт снова свободен', () => {
    const usedAt = '2026-11-03T10:00:00Z';
    const now = new Date(new Date(usedAt).getTime() + ACTIVATION_WINDOW_MS);
    expect(isSpent({ usedAt }, now)).toBe(false);
  });

  it('не использованный аккаунт свободен', () => {
    expect(isSpent({ usedAt: null }, new Date('2026-11-03T10:00:00Z'))).toBe(false);
  });

  it('своё окно у каждого аккаунта: активированный в 23:50 живёт до 23:50 следующего дня', () => {
    // Активация в 23:50 МСК = 20:50Z.
    const usedAt = '2026-11-03T20:50:00Z';
    // Через два часа (уже 01:50 МСК следующего дня) — ещё израсходован.
    expect(isSpent({ usedAt }, new Date('2026-11-03T22:50:00Z'))).toBe(true);
    // Через 24 часа — свободен.
    expect(isSpent({ usedAt }, new Date('2026-11-04T20:50:00Z'))).toBe(false);
  });

  it('availableAt — момент освобождения аккаунта', () => {
    expect(availableAt('2026-11-03T10:00:00Z')).toBe('2026-11-04T10:00:00.000Z');
    expect(availableAt(null)).toBeNull();
  });
});

describe('мультиаккаунт: порядок списка', () => {
  const now = new Date('2026-11-03T12:00:00Z');

  it('доступные выше израсходованных', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, usedOn: '2026-11-03', usedAt: '2026-11-03T11:00:00Z' }),
        row({ id: 2, usedOn: null, usedAt: null }),
      ],
      now,
    );
    expect(sorted.map((a) => a.id)).toEqual([2, 1]);
  });

  it('аккаунт, активированный 30 часов назад, снова доступен', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, usedOn: '2026-11-02', usedAt: '2026-11-02T06:00:00Z' }),
        row({ id: 2, usedOn: null, usedAt: null }),
      ],
      now,
    );
    expect(sorted.map((a) => a.id)).toEqual([2, 1]);
    expect(isSpent({ usedAt: '2026-11-02T06:00:00Z' }, now)).toBe(false);
  });

  it('активированный 12 часов назад — ещё израсходован (вчерашняя дата не значит «свободен»)', () => {
    // 2026-11-02T23:00Z — это уже 3 ноября в Москве, но окно ещё не истекло.
    expect(isSpent({ usedAt: '2026-11-02T23:00:00Z' }, now)).toBe(true);
  });

  it('среди доступных первым идёт никогда не использованный, дальше — самый давний', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, usedOn: '2026-10-30', usedAt: '2026-10-30T06:00:00Z' }),
        row({ id: 2, usedOn: null, usedAt: null }),
        row({ id: 3, usedOn: '2026-11-01', usedAt: '2026-11-01T06:00:00Z' }),
      ],
      now,
    );
    // Никогда не использованный — первый; дальше тот, что использовался ДАВНЕЕ
    // ВСЕХ (активирован 30.10, то есть раньше, чем 01.11).
    expect(sorted.map((a) => a.id)).toEqual([2, 1, 3]);
  });

  it('израсходованные внизу, между собой — по давноте', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, usedOn: '2026-11-03', usedAt: '2026-11-03T11:00:00Z' }),
        row({ id: 2, usedOn: '2026-11-03', usedAt: '2026-11-03T08:00:00Z' }),
        row({ id: 3, usedOn: null, usedAt: null }),
      ],
      now,
    );
    expect(sorted.map((a) => a.id)).toEqual([3, 2, 1]);
  });

  it('исходный массив не мутируется', () => {
    const input = [
      row({ id: 2, usedOn: '2026-11-03', usedAt: '2026-11-03T11:00:00Z' }),
      row({ id: 1, usedOn: null, usedAt: null }),
    ];
    sortAccounts(input, now);
    expect(input.map((a) => a.id)).toEqual([2, 1]);
  });
});

describe('мультиаккаунт: свод по проектам', () => {
  it('складывает активации и токены по проектам и сортирует по токенам', () => {
    const usage = aggregateUsage([
      { projectId: 1, projectName: 'Матрица РМЗ', tokens: 100 },
      { projectId: 2, projectName: 'Сабантуй', tokens: 500 },
      { projectId: 1, projectName: 'Матрица РМЗ', tokens: 250 },
      { projectId: null, projectName: null, tokens: 10 },
    ]);
    expect(usage).toEqual([
      { projectId: 2, projectName: 'Сабантуй', activations: 1, tokens: 500 },
      { projectId: 1, projectName: 'Матрица РМЗ', activations: 2, tokens: 350 },
      { projectId: null, projectName: null, activations: 1, tokens: 10 },
    ]);
  });

  it('пустой журнал — пустой свод', () => {
    expect(aggregateUsage([])).toEqual([]);
  });
});
