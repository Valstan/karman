import { describe, expect, it } from 'vitest';
import { poolBonusLines, plural, type BonusStatsView } from '@/lib/accounts/pool-stats';

/**
 * Гейт текста блока «Пул и бонусы» (заказ владельца 21.11).
 *
 * «Все равно не понимаю эту статистику, какая-то каша малаша, одна строка про
 * одно говорит, вторая ей противоречит… Надо доработать переработать статистику,
 * ничего не понимаю где тут правда».
 *
 * Значит, под гейтом не только числа (это `minimax-daily-bonus.test.ts`), но и
 * ТЕКСТ: как называется каждое число и в каком порядке строки идут. Здесь —
 * настоящие числа с прода за 21.11 (срез 16:00 МСК).
 */
describe('текст блока «Пул и бонусы»', () => {
  /**
   * `toLocaleString('ru-RU')` разделяет разряды НЕРАЗРЫВНЫМ пробелом — в тесте
   * сравниваем по обычному, иначе ожидания нечитаемы.
   */
  function plain(text: string): string {
    return text.replace(/\u00a0/g, ' ');
  }

  /** Живые числа с прода, 21.11 (окно 05:00 → 05:00 МСК). */
  const stats: BonusStatsView = {
    label: '21.11 → 22.11',
    collected: 135,
    collectedPoints: 85_200,
    consumerTaken: 1,
    consumerTakenPoints: 1_000,
    claimedAccounts: 136,
    handed: 9,
    handedPoints: 7_200,
    stockPoints: 173_200,
    stockAccounts: 141,
    thousands: 52,
    freshPoints: 78_000,
    freshCells: 126,
    freshAccounts: 126,
    freshThousands: 46,
    freshThousandsPoints: 46_000,
    olderPoints: 95_200,
    olderCells: 229,
    cells: [
      { cell: 3, points: 400, accounts: 3 },
      { cell: 4, points: 1000, accounts: 28 },
      { cell: 5, points: 400, accounts: 43 },
      { cell: 6, points: 400, accounts: 37 },
      { cell: 7, points: 1000, accounts: 30 },
    ],
    seriesBroken: 0,
    pointsPerDay: 40_533,
    sliceDays: 3,
    sliceFrom: '2026-11-18',
    sliceTo: '2026-11-20',
  };

  const pool = { free: 126, ready: 95, park: 141 };

  it('строки идут в порядке «что с чем сравнивается» и не спорят друг с другом', () => {
    const lines = poolBonusLines(stats, pool);
    expect(lines.map((line) => line.label)).toEqual([
      'Сутки',
      'Пул',
      'Забор',
      'Отдано',
      'Осталось сегодня',
      'С прошлых суток',
      'Мимо нас',
      'Нитки бонусов',
      'Темп отдачи',
    ]);
  });

  it('окно суток названо явно — иначе «забрали 135» читается как чародейство', () => {
    const lines = poolBonusLines(stats, pool);
    expect(plain(lines[0]!.value)).toBe('21.11 → 22.11 · окно 05:00 → 05:00 МСК (забор бонусов в 05:00)');
  });

  it('забор: сколько клеток, сколько очков, сколько тысячных, сколько аккаунтов', () => {
    const lines = poolBonusLines(stats, pool);
    expect(plain(lines[2]!.value)).toBe(
      '135 клеток на 85 200 очков (из них 52 — тысячные) · обошли 136 аккаунтов',
    );
  });

  it('остаток разделён: сегодняшние клетки и клетки прошлых суток — разные числа', () => {
    const lines = poolBonusLines(stats, pool);
    expect(plain(lines[4]!.value)).toBe(
      '78 000 очков на 126 аккаунтах (из них 46 000 — тысячные, 46 аккаунтов)',
    );
    expect(plain(lines[5]!.value)).toBe('95 200 очков в 229 клетках — номинал, не отдано');
    // Старый счёт «на аккаунтах 173 200» больше не выдаётся за «осталось сегодня».
    expect(lines.some((line) => plain(line.value).includes('173 200'))).toBe(false);
  });

  it('«мимо нас» объясняет, ЧЕЙ это забор, а не «какой потребитель забрал»', () => {
    const lines = poolBonusLines(stats, pool);
    expect(plain(lines[6]!.value)).toBe(
      '1 клетка на 1 000 очков — забрал потребитель до нашего забора',
    );
  });

  it('нитки бонусов: сколько аккаунтов на тысячной и на обычной клетке', () => {
    const lines = poolBonusLines(stats, pool);
    expect(plain(lines[7]!.value)).toBe(
      '58 аккаунтов на тысячной (клетки 4, 7) · 83 аккаунта на обычной (клетки 3, 5, 6) · ни одна серия не сгорела',
    );
  });

  it('темп отдачи — с фактическими сутками, без недельного прогноза', () => {
    const lines = poolBonusLines(stats, pool);
    expect(plain(lines[8]!.value)).toBe(
      '40 533 очк./сутки (2026-11-18—2026-11-20, 3 суток с выдачами)',
    );
    // Недельного «хватит / НЕ хватает» в блоке нет — по заказу владельца.
    expect(lines.some((line) => plain(line.value).includes('неделю'))).toBe(false);
    expect(lines.some((line) => line.label === 'Серии')).toBe(false);
  });

  it('пустые остатки не показываются пустыми строками', () => {
    const empty: BonusStatsView = {
      ...stats,
      olderCells: 0,
      olderPoints: 0,
      consumerTaken: 0,
      consumerTakenPoints: 0,
      thousands: 0,
      freshThousands: 0,
      freshThousandsPoints: 0,
      pointsPerDay: null,
    };
    const labels = poolBonusLines(empty, pool).map((line) => line.label);
    expect(labels).not.toContain('С прошлых суток');
    expect(labels).not.toContain('Мимо нас');
    const lines = poolBonusLines(empty, pool);
    expect(plain(lines[lines.length - 1]!.value)).toBe('—');
  });

  it('окончания по-русски: 1 клетка, 2 клетки, 5 клеток', () => {
    expect(plural(1, 'клетка', 'клетки', 'клеток')).toBe('клетка');
    expect(plural(2, 'клетка', 'клетки', 'клеток')).toBe('клетки');
    expect(plural(5, 'клетка', 'клетки', 'клеток')).toBe('клеток');
    expect(plural(11, 'клетка', 'клетки', 'клеток')).toBe('клеток');
    expect(plural(21, 'клетка', 'клетки', 'клеток')).toBe('клетка');
  });
});
