import { describe, expect, it } from 'vitest';
import {
  canonicalProjectName,
  groupUsage,
  isCommonProject,
  summarizeGroups,
  type JournalUsageRow,
} from './project-groups';

/**
 * Сведение проектов в группы (заказ владельца 21.11): синонимы одного проекта
 * сливаются, продсервер Сарафана виден отдельно, общие очки («brain» и «без
 * проекта») делятся поровну между проектами программирования и сами в
 * статистике не показываются.
 */

/** Строка журнала: один проект, один день, одна активация. */
function row(
  usedOn: string,
  projectName: string | null,
  tokens: number,
  activations = 1,
): JournalUsageRow {
  return { usedOn, projectId: projectName ? 1 : null, projectName, activations, tokens };
}

describe('названия проектов: канон', () => {
  it('синонимы одного проекта приводятся к одному названию', () => {
    expect(canonicalProjectName('Матрица РМЗ')).toBe('Матрица РМЗ');
    expect(canonicalProjectName('MatricaRMZ')).toBe('Матрица РМЗ');
    expect(canonicalProjectName('КАРМАН')).toBe('КАРМАН');
    expect(canonicalProjectName('KARMAN')).toBe('КАРМАН');
    expect(canonicalProjectName('KARMAN hotline relay')).toBe('КАРМАН');
  });

  it('продсервер Сарафана отделён от программирования', () => {
    expect(canonicalProjectName('САРАФАН')).toBe('САРАФАН');
    expect(canonicalProjectName('SARAFAN')).toBe('Прод САРАФАН');
    expect(canonicalProjectName('setka')).toBe('Прод САРАФАН');
  });

  it('регистр и пробелы не важны', () => {
    expect(canonicalProjectName('  sarafan ')).toBe('Прод САРАФАН');
    expect(canonicalProjectName('matricarmz')).toBe('Матрица РМЗ');
  });

  it('чужое название остаётся как есть', () => {
    expect(canonicalProjectName('ГОНЬБА')).toBe('ГОНЬБА');
    expect(canonicalProjectName('Pozvoni')).toBe('Pozvoni');
  });

  it('общие: комната Мозга и «без проекта»', () => {
    expect(isCommonProject('brain')).toBe(true);
    expect(isCommonProject(null)).toBe(true);
    expect(isCommonProject('Матрица РМЗ')).toBe(false);
  });
});

describe('сведение журнала в группы', () => {
  it('строки одного проекта в разных написаниях сливаются', () => {
    const rows = groupUsage(
      [
        row('2026-11-18', 'Матрица РМЗ', 1000),
        row('2026-11-18', 'MatricaRMZ', 400),
        row('2026-11-18', 'SARAFAN', 400),
        row('2026-11-18', 'setka', 400),
      ],
      { shareCommon: true },
    );
    expect(rows).toEqual([
      { group: 'Матрица РМЗ', usedOn: '2026-11-18', activations: 2, tokens: 1400 },
      { group: 'Прод САРАФАН', usedOn: '2026-11-18', activations: 2, tokens: 800 },
    ]);
  });

  it('общие очки делятся поровну между проектами программирования', () => {
    const rows = groupUsage(
      [
        row('2026-11-18', 'Матрица РМЗ', 1000),
        row('2026-11-18', 'САРАФАН', 100),
        row('2026-11-18', 'brain', 700),
        row('2026-11-18', null, 100),
      ],
      { shareCommon: true },
    );
    // Общих 800 очков на два проекта программирования — по 400 каждому.
    expect(rows).toEqual([
      { group: 'Матрица РМЗ', usedOn: '2026-11-18', activations: 2, tokens: 1400 },
      { group: 'САРАФАН', usedOn: '2026-11-18', activations: 2, tokens: 500 },
    ]);
  });

  it('продсервер в доле общих очков не участвует', () => {
    const rows = groupUsage(
      [
        row('2026-11-18', 'Матрица РМЗ', 1000),
        row('2026-11-18', 'SARAFAN', 1000),
        row('2026-11-18', 'brain', 800),
      ],
      { shareCommon: true },
    );
    expect(rows).toEqual([
      { group: 'Матрица РМЗ', usedOn: '2026-11-18', activations: 2, tokens: 1800 },
      { group: 'Прод САРАФАН', usedOn: '2026-11-18', activations: 1, tokens: 1000 },
    ]);
  });

  it('остаток от деления не теряется: сумма долей равна общим очкам', () => {
    const rows = groupUsage(
      [
        row('2026-11-18', 'А', 100),
        row('2026-11-18', 'Б', 100),
        row('2026-11-18', 'В', 100),
        row('2026-11-18', 'brain', 1000),
      ],
      { shareCommon: true },
    );
    const total = rows.reduce((sum, r) => sum + r.tokens, 0);
    expect(total).toBe(1300);
    // 1000 / 3 = 333 + 1: трое получают по 334, один — 333.
    expect(rows.map((r) => r.tokens).sort((a, b) => b - a)).toEqual([434, 433, 433]);
  });

  it('общие очки делятся за каждый день отдельно', () => {
    const rows = groupUsage(
      [
        row('2026-11-17', 'А', 1000),
        row('2026-11-17', 'Б', 100),
        row('2026-11-17', 'brain', 300),
        row('2026-11-18', 'А', 1000),
        row('2026-11-18', 'Б', 100),
        row('2026-11-18', 'brain', 100),
      ],
      { shareCommon: true },
    );
    // Свежие дни сверху; 17.11: общие 300 → по 150 каждому, 18.11: общие 100 →
    // по 50 каждому. Активация общая одна — её получает первый по алфавиту.
    expect(rows).toEqual([
      { group: 'А', usedOn: '2026-11-18', activations: 2, tokens: 1050 },
      { group: 'Б', usedOn: '2026-11-18', activations: 1, tokens: 150 },
      { group: 'А', usedOn: '2026-11-17', activations: 2, tokens: 1150 },
      { group: 'Б', usedOn: '2026-11-17', activations: 1, tokens: 250 },
    ]);
  });

  it('без разложения (блок «Расход по запросам») общих очков в своде нет', () => {
    const rows = groupUsage(
      [row('2026-11-18', 'SARAFAN', 400), row('2026-11-18', 'brain', 400)],
      { shareCommon: false },
    );
    expect(rows).toEqual([
      { group: 'Прод САРАФАН', usedOn: '2026-11-18', activations: 1, tokens: 400 },
    ]);
  });

  it('если получателей нет, общие очки просто не показываются', () => {
    const rows = groupUsage([row('2026-11-18', 'brain', 400)], { shareCommon: true });
    expect(rows).toEqual([]);
  });

  it('свод по группам: больше очков — выше', () => {
    const rows = groupUsage(
      [
        row('2026-11-18', 'Матрица РМЗ', 1000),
        row('2026-11-18', 'САРАФАН', 400),
        row('2026-11-18', 'Матрица РМЗ', 400),
      ],
      { shareCommon: true },
    );
    expect(summarizeGroups(rows)).toEqual([
      { group: 'Матрица РМЗ', activations: 2, tokens: 1400 },
      { group: 'САРАФАН', activations: 1, tokens: 400 },
    ]);
  });
});
