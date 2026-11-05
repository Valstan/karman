import { describe, expect, it } from 'vitest';
import {
  aggregateDailyUsage,
  fillDailySeries,
  rankAccounts,
  shiftDate,
  sortDailyUsage,
  type AccountRatingRow,
} from './stats';

/**
 * Статистика мультиаккаунта — чистые функции без БД (заказ владельца 05.11).
 *
 * Смысл гейта: числа в статистике не должны разъезжаться между собой. Здесь
 * считается всё, что дальше рисуется на экране: свод по дням, непрерывный ряд
 * для графика, сортировка таблицы сумм и рейтинг аккаунтов.
 */
describe('свод по дням', () => {
  it('группирует журнал по московской дате и считает активации, проекты и токены', () => {
    const days = aggregateDailyUsage([
      { usedOn: '2026-11-03', projectId: 1, tokens: 100 },
      { usedOn: '2026-11-03', projectId: 1, tokens: 50 },
      { usedOn: '2026-11-03', projectId: 2, tokens: 25 },
      { usedOn: '2026-11-04', projectId: 2, tokens: 10 },
    ]);

    expect(days).toHaveLength(2);
    // Свежие сверху.
    expect(days[0]!.usedOn).toBe('2026-11-04');
    expect(days[0]!.activations).toBe(1);
    expect(days[0]!.projects).toBe(1);
    expect(days[0]!.tokens).toBe(10);

    expect(days[1]!.usedOn).toBe('2026-11-03');
    expect(days[1]!.activations).toBe(3);
    // Проекты считаются РАЗНЫЕ: повтор по одному проекту не завышает счётчик.
    expect(days[1]!.projects).toBe(2);
    expect(days[1]!.tokens).toBe(175);
  });

  it('активация без проекта не считается проектом', () => {
    const days = aggregateDailyUsage([
      { usedOn: '2026-11-03', projectId: null, tokens: 5 },
      { usedOn: '2026-11-03', projectId: null, tokens: 5 },
    ]);

    expect(days[0]!.activations).toBe(2);
    expect(days[0]!.projects).toBe(0);
    expect(days[0]!.tokens).toBe(10);
  });

  it('пустой журнал даёт пустой свод', () => {
    expect(aggregateDailyUsage([])).toEqual([]);
  });
});

describe('непрерывный ряд для графика', () => {
  it('дорисовывает дни без активаций нулями и идёт от старого к новому', () => {
    const series = fillDailySeries(
      [{ usedOn: '2026-11-04', activations: 2, projects: 1, tokens: 30 }],
      4,
      '2026-11-05',
    );

    expect(series.map((d) => d.usedOn)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ]);
    expect(series[0]!.activations).toBe(0);
    expect(series[0]!.tokens).toBe(0);
    expect(series[2]!.activations).toBe(2);
    expect(series[2]!.tokens).toBe(30);
    expect(series[3]!.activations).toBe(0);
  });

  it('длина ряда равна запрошенному числу дней', () => {
    const series = fillDailySeries([], 90, '2026-11-05');
    expect(series).toHaveLength(90);
    expect(series[0]!.usedOn).toBe('2026-08-08');
    expect(series[89]!.usedOn).toBe('2026-11-05');
  });
});

describe('сортировка таблицы сумм', () => {
  const rows = [
    { usedOn: '2026-11-01', activations: 5, projects: 1, tokens: 10 },
    { usedOn: '2026-11-02', activations: 1, projects: 3, tokens: 90 },
    { usedOn: '2026-11-03', activations: 9, projects: 2, tokens: 40 },
  ];

  it('сортирует по активациям вниз', () => {
    const sorted = sortDailyUsage(rows, 'activations', 'desc');
    expect(sorted.map((r) => r.usedOn)).toEqual(['2026-11-03', '2026-11-01', '2026-11-02']);
  });

  it('сортирует по токенам вверх', () => {
    const sorted = sortDailyUsage(rows, 'tokens', 'asc');
    expect(sorted.map((r) => r.usedOn)).toEqual(['2026-11-01', '2026-11-03', '2026-11-02']);
  });

  it('сортирует по проектам', () => {
    const sorted = sortDailyUsage(rows, 'projects', 'desc');
    expect(sorted.map((r) => r.usedOn)).toEqual(['2026-11-02', '2026-11-03', '2026-11-01']);
  });

  it('при равенстве метрики свежий день выше', () => {
    const equal = [
      { usedOn: '2026-11-01', activations: 3, projects: 1, tokens: 5 },
      { usedOn: '2026-11-05', activations: 3, projects: 1, tokens: 5 },
    ];
    const sorted = sortDailyUsage(equal, 'activations', 'desc');
    expect(sorted.map((r) => r.usedOn)).toEqual(['2026-11-05', '2026-11-01']);
  });

  it('исходный массив не трогается', () => {
    const copy = [...rows];
    sortDailyUsage(rows, 'tokens', 'asc');
    expect(rows).toEqual(copy);
  });
});

describe('рейтинг аккаунтов', () => {
  const rows: AccountRatingRow[] = [
    { id: 1, title: 'А', email: 'a@example.test', activations: 3, tokens: 10 },
    { id: 2, title: 'Б', email: 'b@example.test', activations: 7, tokens: 5 },
    { id: 3, title: 'В', email: 'c@example.test', activations: 7, tokens: 90 },
    { id: 4, title: 'Г', email: 'd@example.test', activations: 1, tokens: 0 },
  ];

  it('сортирует по числу активаций, при равенстве — по токенам', () => {
    const ranked = rankAccounts(rows, 10);
    expect(ranked.map((r) => r.id)).toEqual([3, 2, 1, 4]);
  });

  it('обрезает до десятки', () => {
    const many: AccountRatingRow[] = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      title: `А${i}`,
      email: `a${i}@example.test`,
      activations: i,
      tokens: i,
    }));
    expect(rankAccounts(many, 10)).toHaveLength(10);
    expect(rankAccounts(many, 10)[0]!.id).toBe(25);
  });
});

describe('календарный сдвиг даты', () => {
  it('переносит через конец месяца и конец года', () => {
    expect(shiftDate('2026-11-30', 1)).toBe('2026-12-01');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2026-11-05', -1)).toBe('2026-11-04');
  });

  it('переносит через февраль високосного года', () => {
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDate('2028-02-29', 1)).toBe('2028-03-01');
  });
});
