import { describe, expect, it } from 'vitest';
import {
  aggregateUsage,
  isSpentToday,
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

describe('мультиаккаунт: граница суток', () => {
  it('московская дата — по UTC+3, а не по времени машины', () => {
    // 2026-11-02T21:30Z — это уже 3 ноября в Москве (UTC+3).
    expect(moscowToday(new Date('2026-11-02T21:30:00Z'))).toBe('2026-11-03');
    // За час до полуночи по Москве ещё 2-е.
    expect(moscowToday(new Date('2026-11-02T20:59:00Z'))).toBe('2026-11-02');
  });

  it('аккаунт израсходован сегодня, если used_on = сегодняшняя дата', () => {
    expect(isSpentToday({ usedOn: '2026-11-03' }, '2026-11-03')).toBe(true);
    expect(isSpentToday({ usedOn: '2026-11-02' }, '2026-11-03')).toBe(false);
    expect(isSpentToday({ usedOn: null }, '2026-11-03')).toBe(false);
  });
});

describe('мультиаккаунт: порядок списка', () => {
  const today = '2026-11-03';

  it('доступные выше израсходованных', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, usedOn: today, usedAt: '2026-11-03T09:00:00Z' }),
        row({ id: 2, usedOn: null, usedAt: null }),
      ],
      today,
    );
    expect(sorted.map((a) => a.id)).toEqual([2, 1]);
  });

  it('вчерашний аккаунт снова доступен сегодня', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, usedOn: '2026-11-02', usedAt: '2026-11-02T09:00:00Z' }),
        row({ id: 2, usedOn: null, usedAt: null }),
      ],
      today,
    );
    expect(sorted.map((a) => a.id)).toEqual([2, 1]);
    expect(isSpentToday({ usedOn: '2026-11-02' }, today)).toBe(false);
  });

  it('среди доступных первым идёт никогда не использованный, дальше — самый давний', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, usedOn: '2026-11-01', usedAt: '2026-11-01T09:00:00Z' }),
        row({ id: 2, usedOn: null, usedAt: null }),
        row({ id: 3, usedOn: '2026-10-30', usedAt: '2026-10-30T09:00:00Z' }),
      ],
      today,
    );
    expect(sorted.map((a) => a.id)).toEqual([2, 3, 1]);
  });

  it('израсходованные внизу, между собой — по давноте', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, usedOn: today, usedAt: '2026-11-03T12:00:00Z' }),
        row({ id: 2, usedOn: today, usedAt: '2026-11-03T08:00:00Z' }),
        row({ id: 3, usedOn: null, usedAt: null }),
      ],
      today,
    );
    expect(sorted.map((a) => a.id)).toEqual([3, 2, 1]);
  });

  it('исходный массив не мутируется', () => {
    const input = [row({ id: 2, usedOn: today }), row({ id: 1, usedOn: null })];
    sortAccounts(input, today);
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
