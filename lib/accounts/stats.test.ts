import { describe, expect, it } from 'vitest';
import {
  aggregateDailyUsage,
  buildChampionship,
  championshipLeaders,
  fillDailySeries,
  shiftDate,
  sortDailyUsage,
  sortProjectsByUsage,
  type ProjectDayPoints,
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

describe('чемпионат по проектам', () => {
  const rows: ProjectDayPoints[] = [
    // 18.11: А потратил больше всех (3), Б — второй (2), В — третий (1).
    { usedOn: '2026-11-18', projectId: 1, projectName: 'А', points: 2000 },
    { usedOn: '2026-11-18', projectId: 2, projectName: 'Б', points: 1000 },
    { usedOn: '2026-11-18', projectId: 3, projectName: 'В', points: 400 },
    // 19.11: Б обошёл А (теперь Б первый), В выбыл из тройки.
    { usedOn: '2026-11-19', projectId: 2, projectName: 'Б', points: 1600 },
    { usedOn: '2026-11-19', projectId: 1, projectName: 'А', points: 800 },
  ];

  it('за сутки даёт 3, 2 и 1 балл лидерам по потраченным очкам', () => {
    const table = buildChampionship(rows);
    const byName = new Map(table.map((row) => [row.projectName, row]));
    // 18.11: А (2000) — 3 балла, Б (1000) — 2, В (400) — 1.
    // 19.11: Б (1600) — 3 балла, А (800) — 2 (В в тот день ничего не тратил).
    expect(byName.get('Б')?.points).toBe(5); // 2 (18.11) + 3 (19.11)
    expect(byName.get('А')?.points).toBe(5); // 3 (18.11) + 2 (19.11)
    expect(byName.get('В')?.points).toBe(1); // 1 (18.11)
  });

  it('таблицу строит по набранным баллам, при равенстве — по потраченным очкам', () => {
    const table = buildChampionship(rows);
    // Б и А набрали по 4 балла. Потратили А — 2800, Б — 2600, значит выше А.
    expect(table.map((row) => row.projectName)).toEqual(['А', 'Б', 'В']);
  });

  it('считает потраченные очки, сутки в тройке и победы', () => {
    const table = buildChampionship(rows);
    const a = table.find((row) => row.projectName === 'А')!;
    expect(a.spent).toBe(2800);
    expect(a.topDays).toBe(2);
    expect(a.wins).toBe(1);
    expect(a.days).toBe(2);
  });

  it('проект без очков в сутки баллов не получает, а активация без проекта не участвует', () => {
    const table = buildChampionship([
      ...rows,
      { usedOn: '2026-11-19', projectId: 4, projectName: 'Г', points: 0 },
      { usedOn: '2026-11-19', projectId: null, projectName: null, points: 5000 },
    ]);
    expect(table.find((row) => row.projectName === 'Г')).toBeUndefined();
    expect(table).toHaveLength(3);
  });

  it('лидеры последних суток — по очкам этого дня', () => {
    const { usedOn, leaders } = championshipLeaders(rows);
    expect(usedOn).toBe('2026-11-19');
    expect(leaders.map((leader) => [leader.projectName, leader.score, leader.points])).toEqual([
      ['Б', 3, 1600],
      ['А', 2, 800],
    ]);
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

describe('порядок проектов в списке выбора', () => {
  const projects = [
    { id: 1, name: 'Матрица РМЗ' },
    { id: 2, name: 'Сабантуй' },
    { id: 3, name: 'Казанская' },
    { id: 4, name: 'Новый' },
  ];

  it('чаще используемые — сверху', () => {
    const sorted = sortProjectsByUsage(projects, [
      { projectId: 3, activations: 9, tokens: 100 },
      { projectId: 1, activations: 4, tokens: 900 },
      { projectId: 2, activations: 4, tokens: 50 },
    ]);
    expect(sorted.map((p) => p.id)).toEqual([3, 1, 2, 4]);
  });

  it('при равном числе активаций решают токены', () => {
    const sorted = sortProjectsByUsage(projects, [
      { projectId: 2, activations: 4, tokens: 50 },
      { projectId: 1, activations: 4, tokens: 900 },
    ]);
    expect(sorted.map((p) => p.id)).toEqual([1, 2, 3, 4]);
  });

  it('проект без активаций уходит вниз, а «без проекта» в список не попадает', () => {
    const sorted = sortProjectsByUsage(projects, [
      { projectId: null, activations: 100, tokens: 1000 },
    ]);
    // Ни у кого активаций нет — порядок по названию: Казанская, Матрица РМЗ,
    // Новый, Сабантуй.
    expect(sorted.map((p) => p.id)).toEqual([3, 1, 4, 2]);
    expect(sorted.map((p) => p.id)).not.toContain(null);
  });

  it('исходный массив не трогается', () => {
    const copy = [...projects];
    sortProjectsByUsage(projects, [{ projectId: 3, activations: 9, tokens: 100 }]);
    expect(projects).toEqual(copy);
  });
});
