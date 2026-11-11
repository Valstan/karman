import { describe, expect, it } from 'vitest';
import {
  WEEKLY_ACTIVATION_LIMIT,
  WEEKLY_ACTIVATION_POINTS,
  WEEKLY_POINTS_TOTAL,
  calendarWeek,
  cycleCell,
  cycleDayNumber,
  daysToBonus,
  moscowWeekStart,
  pointsForIndex,
  weeklyPoolStats,
  weeklyQuota,
  type WeeklyAccountInput,
  type WeeklyCheckIn,
} from '@/lib/accounts/weekly';

/**
 * Модель недели MiniMax после разбора боевых данных 09.11:
 *
 * - **номер клетки** — серия дней подряд (пропущенный день обрывает серию);
 * - **недельная квота** — календарная неделя понедельник–воскресенье, лимиты
 *   обнуляются в ночь на понедельник.
 *
 * Понедельник 09.11.2026.
 */
const today = '2026-11-09';

function checkIn(date: string, index: number | null = null): WeeklyCheckIn {
  return { date, index };
}

describe('очки по клеткам', () => {
  it('в 4-й и 7-й клетке — 1000, в остальных — 400, за неделю 4000', () => {
    expect([...WEEKLY_ACTIVATION_POINTS]).toEqual([400, 400, 400, 1000, 400, 400, 1000]);
    expect(WEEKLY_POINTS_TOTAL).toBe(4000);
    expect(pointsForIndex(1)).toBe(400);
    expect(pointsForIndex(4)).toBe(1000);
    expect(pointsForIndex(7)).toBe(1000);
  });
});

describe('номер клетки — серия дней подряд (разбор 09.11)', () => {
  it('никогда не отмеченный аккаунт: первая клетка', () => {
    const quota = weeklyQuota([], today);
    expect(quota.streak).toBe(0);
    expect(quota.nextIndex).toBe(1);
    expect(quota.used).toBe(0);
    expect(quota.remaining).toBe(WEEKLY_ACTIVATION_LIMIT);
    expect(quota.pointsLeft).toBe(4000);
    expect(quota.exhausted).toBe(false);
  });

  it('отмечен вчера → сегодня вторая клетка (боевые данные 09.11)', () => {
    // 08.11 отмечен, 09.11 — вторая клетка. Именно так нажал владелец.
    const quota = weeklyQuota([checkIn('2026-11-08', 2)], today);
    expect(quota.streak).toBe(1);
    expect(quota.nextIndex).toBe(2);
    expect(quota.anchorDate).toBe('2026-11-08');
  });

  it('вчера пропущено → серия сгорела, снова первая клетка', () => {
    // Последняя отметка 07.11: 08.11 пропущено — серия оборвалась.
    const quota = weeklyQuota(
      [checkIn('2026-11-05'), checkIn('2026-11-06'), checkIn('2026-11-07')],
      today,
    );
    expect(quota.streak).toBe(0);
    expect(quota.nextIndex).toBe(1);
    expect(quota.anchorDate).toBeNull();
  });

  it('серия из трёх дней → четвёртая клетка (1000 очков)', () => {
    const quota = weeklyQuota(
      [checkIn('2026-11-06'), checkIn('2026-11-07'), checkIn('2026-11-08')],
      today,
    );
    expect(quota.streak).toBe(3);
    expect(quota.nextIndex).toBe(4);
    expect(pointsForIndex(quota.nextIndex!)).toBe(1000);
  });

  it('серия длиннее шести дней — седьмая клетка и дальше не растёт', () => {
    const rows = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
    const quota = weeklyQuota(rows.map((d) => checkIn(d)), today);
    expect(quota.streak).toBe(6);
    expect(quota.nextIndex).toBe(7);
  });

  it('отмечен сегодня → подсказка на завтра (вторая клетка серии)', () => {
    const quota = weeklyQuota([checkIn('2026-11-09', 1)], today);
    expect(quota.streak).toBe(1);
    expect(quota.nextIndex).toBe(2);
  });

  it('номер владельца записывается, но подсказку не двигает', () => {
    // Владелец назвал 2 (так на настоящей панели) — но считаем по датам:
    // отмечен вчера → сегодня вторая клетка.
    const quota = weeklyQuota([checkIn('2026-11-08', 2)], today);
    expect(quota.confirmedIndex).toBe(2);
    expect(quota.nextIndex).toBe(2);
  });
});

describe('недельная квота — календарная неделя (понедельник — воскресенье)', () => {
  it('неделя — понедельник 09.11 по воскресенье 15.11', () => {
    const cycle = calendarWeek(today);
    expect(cycle.startDate).toBe('2026-11-09');
    expect(cycle.endDate).toBe('2026-11-15');
    expect(moscowWeekStart(today)).toBe('2026-11-09');
    expect(cycleDayNumber(cycle, '2026-11-09')).toBe(1);
  });

  it('отметки прошлой недели в счёт не идут (сброс — в ночь на понедельник)', () => {
    const quota = weeklyQuota(
      [checkIn('2026-11-05'), checkIn('2026-11-06'), checkIn('2026-11-07'), checkIn('2026-11-08')],
      today,
    );
    expect(quota.used).toBe(0);
    expect(quota.remaining).toBe(7);
  });

  it('отметка сегодня заняла один день недели', () => {
    const quota = weeklyQuota([checkIn('2026-11-09', 1)], today);
    expect(quota.used).toBe(1);
    expect(quota.remaining).toBe(6);
    expect(quota.exhausted).toBe(false);
  });

  it('все семь дней недели заняты → неделя исчерпана', () => {
    const rows = [
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ];
    const quota = weeklyQuota(rows.map((d) => checkIn(d)), '2026-11-15');
    expect(quota.used).toBe(7);
    expect(quota.remaining).toBe(0);
    expect(quota.exhausted).toBe(true);
    expect(quota.nextIndex).toBeNull();
    expect(quota.pointsLeft).toBe(0);
  });

  it('очки за оставшиеся дни считаются по продолжению серии', () => {
    // Отмечен вчера (08.11, вне календарной недели) → сегодня клетка 2 (400),
    // дальше 3 (400), 4 (1000), 5, 6, 7 (1000) и снова 1 (400): неделя чек-инов
    // начинается заново (решение владельца 11.11). Семь дней дают ровно 4000 —
    // столько же, сколько в документации MiniMax.
    const quota = weeklyQuota([checkIn('2026-11-08')], today);
    expect(quota.pointsLeft).toBe(400 + 400 + 1000 + 400 + 400 + 1000 + 400);
    expect(quota.pointsLeft).toBe(WEEKLY_POINTS_TOTAL);
  });
});

describe('сводка по запасу — строка лимитов', () => {
  function account(id: number, over: Partial<WeeklyAccountInput> = {}): WeeklyAccountInput {
    return {
      id,
      spent: false,
      releasesAt: null,
      checkedInToday: false,
      quota: weeklyQuota([], today),
      ...over,
    };
  }

  const now = '2026-11-09T10:00:00Z';

  it('за день: свободны сейчас и освобождающиеся сегодня; отдельно — в ближайшие 5 часов', () => {
    const stats = weeklyPoolStats([account(1)], [], today, now);
    expect(stats.today).toBe(1);
    expect(stats.freeNow).toBe(1);
    expect(stats.freesIn5h).toBe(0);
  });

  it('аккаунт, освобождающийся через 2 часа, попадает в «в ближайшие 5 часов»', () => {
    const stats = weeklyPoolStats(
      [
        account(1, { spent: true, releasesAt: '2026-11-09T12:00:00Z' }),
        account(2, { spent: true, releasesAt: '2026-11-09T18:00:00Z' }),
        account(3, { spent: true, releasesAt: '2026-11-10T10:00:00Z' }),
      ],
      [],
      today,
      now,
    );
    expect(stats.today).toBe(2);
    expect(stats.freeNow).toBe(0);
    expect(stats.freesIn5h).toBe(1);
  });

  it('отмеченные сегодня в «за день» не идут', () => {
    const stats = weeklyPoolStats([account(1, { checkedInToday: true })], [], today, now);
    expect(stats.today).toBe(0);
    expect(stats.week).toBe(7);
  });

  it('за неделю — остаток календарной недели, темп и прогноз в днях', () => {
    const stats = weeklyPoolStats(
      [account(1, { quota: weeklyQuota([checkIn('2026-11-05')], today) }), account(2)],
      [{ usedOn: '2026-11-09', activations: 4 }],
      today,
      now,
    );
    // Оба аккаунта могут отметить все семь дней недели.
    expect(stats.week).toBe(14);
    // Темп: 4 активации за один прошедший день недели.
    expect(stats.perDay).toBe(4);
    expect(stats.daysLeft).toBeCloseTo(3.5, 5);
    expect(stats.daysToWeekEnd).toBe(7);
    // Сброс недельных лимитов — в ночь на понедельник следующей недели.
    expect(stats.weekResetsOn).toBe('2026-11-16');
  });

  it('без активаций темп неизвестен — прогноза нет, а не ноль', () => {
    const stats = weeklyPoolStats([account(1)], [], today, now);
    expect(stats.perDay).toBe(0);
    expect(stats.daysLeft).toBeNull();
    expect(stats.coversWeek).toBeNull();
  });
});

describe('после седьмой клетки цикл начинается заново (решение владельца 11.11)', () => {
  // Неделя чек-инов MiniMax: семь дней подряд — 4000 очков, дальше неделя
  // начинается заново. Значит 8-й день подряд — снова первая клетка (400), а не
  // «седьмая» (1000). До 11.11 код потолковал клетку семью и обещал 1000.
  const day = '2026-11-11';

  it('шесть дней подряд: сегодня седьмая клетка — 1000 очков', () => {
    const rows = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']
      .map((d) => checkIn(d));
    const quota = weeklyQuota(rows, day);
    expect(quota.streak).toBe(6);
    expect(quota.nextIndex).toBe(7);
    expect(quota.pointsToday).toBe(1000);
    expect(quota.daysToBonus).toBe(1);
  });

  it('семь дней подряд: восьмой день — снова первая клетка и 400 очков', () => {
    const rows = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']
      .map((d) => checkIn(d));
    const quota = weeklyQuota(rows, '2026-11-12');
    expect(quota.streak).toBe(7);
    expect(quota.nextIndex).toBe(1);
    expect(quota.pointsToday).toBe(400);
    // До ближайшего бонуса — четыре дня (1, 2, 3, 4).
    expect(quota.daysToBonus).toBe(4);
  });

  it('клетка циклится: восьмая серия даёт вторую клетку', () => {
    expect(cycleCell(0)).toBe(1);
    expect(cycleCell(5)).toBe(6);
    expect(cycleCell(6)).toBe(7);
    expect(cycleCell(7)).toBe(1);
    expect(cycleCell(8)).toBe(2);
  });

  it('расстояние до ближайшей бонусной клетки', () => {
    expect(daysToBonus(0)).toBe(4);   // свежий: 1, 2, 3, 4
    expect(daysToBonus(2)).toBe(2);   // сегодня третья, завтра четвёртая
    expect(daysToBonus(3)).toBe(1);   // сегодня четвёртая — 1000
    expect(daysToBonus(5)).toBe(2);   // сегодня шестая, завтра седьмая
    expect(daysToBonus(6)).toBe(1);   // сегодня седьмая — 1000
  });

  it('отмеченный сегодня: очков сегодня 0, номер — завтрашний', () => {
    const rows = ['2026-11-09', '2026-11-10', '2026-11-11'].map((d) => checkIn(d));
    const quota = weeklyQuota(rows, day);
    expect(quota.streak).toBe(3);
    expect(quota.pointsToday).toBe(0);
    // Завтра аккаунт продолжит серию и получит четвёртую клетку (1000).
    expect(quota.nextIndex).toBe(4);
  });

  it('проекция очков переходит через седьмую клетку на перезапуск', () => {
    // Серия из шести дней, сегодня (11.11) не отмечен: впереди седьмая клетка
    // (1000), а потом цикл начинается заново — 1 (400), 2 (400), 3 (400),
    // 4 (1000). До конца календарной недели осталось пять дней.
    const rows = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']
      .map((d) => checkIn(d));
    const quota = weeklyQuota(rows, day);
    expect(quota.nextIndex).toBe(7);
    expect(quota.pointsLeft).toBe(1000 + 400 + 400 + 400 + 1000);
  });
});
