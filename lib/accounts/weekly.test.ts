import { describe, expect, it } from 'vitest';
import {
  WEEKLY_ACTIVATION_LIMIT,
  WEEKLY_ACTIVATION_POINTS,
  WEEKLY_POINTS_TOTAL,
  moscowWeekStart,
  pointsForIndex,
  remainingPoints,
  weeklyCycle,
  weeklyPoolStats,
  weeklyQuota,
  type WeeklyAccountInput,
  type WeeklyCheckIn,
} from '@/lib/accounts/weekly';

/** Чек-ин аккаунта: дата и (необязательно) подтверждённый номер активации. */
function checkIn(date: string, index: number | null = null): WeeklyCheckIn {
  return { date, index };
}

describe('недельная квота MiniMax: очки по номеру активации', () => {
  it('4-я и 7-я активации дают 1000, остальные — 400', () => {
    // Ровно то, что в документации MiniMax (400 в обычный день, 1000 в 4-й
    // и 7-й день подряд).
    expect([...WEEKLY_ACTIVATION_POINTS]).toEqual([400, 400, 400, 1000, 400, 400, 1000]);
    expect(pointsForIndex(1)).toBe(400);
    expect(pointsForIndex(3)).toBe(400);
    expect(pointsForIndex(4)).toBe(1000);
    expect(pointsForIndex(6)).toBe(400);
    expect(pointsForIndex(7)).toBe(1000);
  });

  it('за полную неделю набегает 4000 очков', () => {
    expect(WEEKLY_POINTS_TOTAL).toBe(4000);
    expect([...WEEKLY_ACTIVATION_POINTS].reduce((a, b) => a + b, 0)).toBe(4000);
  });

  it('очки за оставшиеся активации — сумма по их номерам', () => {
    expect(remainingPoints(0)).toBe(4000);
    expect(remainingPoints(3)).toBe(1000 + 400 + 400 + 1000);
    expect(remainingPoints(6)).toBe(1000);
    expect(remainingPoints(7)).toBe(0);
  });
});

describe('недельная квота: цикл аккаунта', () => {
  it('неделя у аккаунта своя: от его первого чек-ина, кусками по 7 дней', () => {
    // Точка отсчёта — первая активация аккаунта (не общий понедельник).
    const cycle = weeklyCycle('2026-11-04', '2026-11-06');
    expect(cycle.anchorDate).toBe('2026-11-04');
    expect(cycle.cycleIndex).toBe(0);
    expect(cycle.startDate).toBe('2026-11-04');
    expect(cycle.endDate).toBe('2026-11-10');
  });

  it('через 7 дней от первого чек-ина начинается новый цикл', () => {
    const cycle = weeklyCycle('2026-11-04', '2026-11-11');
    expect(cycle.cycleIndex).toBe(1);
    expect(cycle.startDate).toBe('2026-11-11');
    expect(cycle.endDate).toBe('2026-11-17');
  });

  it('понедельник московской недели — для темпа и прогноза', () => {
    // 2026-11-07 — суббота.
    expect(moscowWeekStart('2026-11-07')).toBe('2026-11-02');
    // Понедельник сам по себе.
    expect(moscowWeekStart('2026-11-02')).toBe('2026-11-02');
  });
});

describe('недельная квота: состояние аккаунта', () => {
  const today = '2026-11-06';

  it('никогда не активировавшийся аккаунт: первая активация — первая в неделе', () => {
    const quota = weeklyQuota([], today);
    expect(quota.anchorDate).toBeNull();
    expect(quota.used).toBe(0);
    expect(quota.nextIndex).toBe(1);
    expect(quota.exhausted).toBe(false);
    expect(quota.remaining).toBe(WEEKLY_ACTIVATION_LIMIT);
    expect(quota.pointsLeft).toBe(4000);
  });

  it('три чек-ина в цикле → следующая активация четвёртая, очки 1000', () => {
    const quota = weeklyQuota(
      [checkIn('2026-11-04'), checkIn('2026-11-05'), checkIn('2026-11-06')],
      today,
    );
    expect(quota.anchorDate).toBe('2026-11-04');
    expect(quota.used).toBe(3);
    expect(quota.nextIndex).toBe(4);
    expect(quota.pointsLeft).toBe(2800);
  });

  it('семь чек-инов → неделя исчерпана, аккаунт больше не предлагается', () => {
    const quota = weeklyQuota(
      [
        checkIn('2026-11-04'),
        checkIn('2026-11-05'),
        checkIn('2026-11-06'),
        checkIn('2026-11-07'),
        checkIn('2026-11-08'),
        checkIn('2026-11-09'),
        checkIn('2026-11-10'),
      ],
      '2026-11-10',
    );
    expect(quota.used).toBe(7);
    expect(quota.remaining).toBe(0);
    expect(quota.exhausted).toBe(true);
    expect(quota.nextIndex).toBeNull();
    expect(quota.pointsLeft).toBe(0);
  });

  it('новый цикл — счёт с нуля', () => {
    // Семь чек-инов в первом цикле, 11.11 — уже следующая неделя аккаунта.
    const quota = weeklyQuota(
      [
        checkIn('2026-11-04'),
        checkIn('2026-11-05'),
        checkIn('2026-11-06'),
        checkIn('2026-11-07'),
        checkIn('2026-11-08'),
        checkIn('2026-11-09'),
        checkIn('2026-11-10'),
      ],
      '2026-11-11',
    );
    expect(quota.cycle.cycleIndex).toBe(1);
    expect(quota.used).toBe(0);
    expect(quota.exhausted).toBe(false);
    expect(quota.nextIndex).toBe(1);
  });

  it('подтверждённый владельцем номер продолжает счёт, а не ломает квоту', () => {
    // Строки без номеров (старый журнал): квота считается по числу строк,
    // номер активации — по умолчанию used + 1.
    const byRows = weeklyQuota([checkIn('2026-11-04'), checkIn('2026-11-05')], today);
    expect(byRows.used).toBe(2);
    expect(byRows.nextIndex).toBe(3);
    expect(byRows.confirmedIndex).toBeNull();

    // Владелец уточнил: 05.11 была 4-я активация (значит, день пропущен).
    // С этого номера продолжаем — 05.11, и очки считаются по нему.
    const byIndex = weeklyQuota([checkIn('2026-11-05', 4)], today);
    expect(byIndex.used).toBe(1);
    expect(byIndex.confirmedIndex).toBe(4);
    expect(byIndex.nextIndex).toBe(5);
  });

  it('чек-ины вне текущего цикла в счёт не идут', () => {
    const quota = weeklyQuota(
      [checkIn('2026-11-01'), checkIn('2026-11-02'), checkIn('2026-11-03'), checkIn('2026-11-05')],
      today,
    );
    // Точка отсчёта — 01.11; цикл 01..07.11, значит все четыре входят.
    expect(quota.used).toBe(4);
    expect(quota.cycle.startDate).toBe('2026-11-01');
    expect(quota.cycle.endDate).toBe('2026-11-07');
  });
});

describe('недельная квота: сводка по запасу', () => {
  const today = '2026-11-07';

  function account(over: Partial<WeeklyAccountInput> & { id: number }): WeeklyAccountInput {
    const quota = weeklyQuota([], today);
    return {
      spent: false,
      releasesAt: null,
      checkedInToday: false,
      quota,
      ...over,
    };
  }

  it('за день считаются свободные и освобождающиеся сегодня, у которых есть неделя', () => {
    const stats = weeklyPoolStats(
      [
        account({ id: 1 }),
        // Освободится сегодня (московская дата освобождения — сегодня).
        account({ id: 2, spent: true, releasesAt: '2026-11-07T12:00:00Z' }),
        // Освободится завтра — сегодня не активируется.
        account({ id: 3, spent: true, releasesAt: '2026-11-08T12:00:00Z' }),
        // Сегодня уже чекинился — повторный чек-ин очков не даёт.
        account({ id: 4, checkedInToday: true }),
        // Неделя исчерпана — не предлагается.
        account({ id: 5, quota: weeklyQuota(
          [
            checkIn('2026-11-01'),
            checkIn('2026-11-02'),
            checkIn('2026-11-03'),
            checkIn('2026-11-04'),
            checkIn('2026-11-05'),
            checkIn('2026-11-06'),
            checkIn('2026-11-07'),
          ],
          today,
        ) }),
      ],
      [],
      today,
    );
    expect(stats.today).toBe(2);
  });

  it('за неделю — сумма остатков недельных квот, и очки по ним', () => {
    const stats = weeklyPoolStats(
      [
        account({ id: 1, quota: weeklyQuota([checkIn('2026-11-05')], today) }),
        account({ id: 2, quota: weeklyQuota([], today) }),
      ],
      [],
      today,
    );
    // У первого использовано 1 → осталось 6 (4000−400=3600 очков),
    // у второго использовано 0 → осталось 7 (4000 очков).
    expect(stats.week).toBe(13);
    expect(stats.weekPoints).toBe(7600);
  });

  it('темп считается по текущей московской неделе, прогноз — «хватит ли до конца»', () => {
    // Неделя 02..08.11, сегодня 07.11 — прошло 6 дней (02,03,04,05,06,07).
    const stats = weeklyPoolStats(
      [account({ id: 1 })],
      [
        { usedOn: '2026-11-02', activations: 4 },
        { usedOn: '2026-11-03', activations: 4 },
        { usedOn: '2026-11-04', activations: 4 },
        { usedOn: '2026-11-05', activations: 4 },
        { usedOn: '2026-11-06', activations: 4 },
        { usedOn: '2026-11-07', activations: 4 },
        // Прошлой недели — в темп не входит.
        { usedOn: '2026-11-01', activations: 40 },
      ],
      today,
    );
    expect(stats.perDay).toBe(4);
    expect(stats.daysToWeekEnd).toBe(2);
    // Остаток 7 активаций при темпе 4 в день — на 1.75 дня.
    expect(stats.week).toBe(7);
    expect(stats.daysLeft).toBeCloseTo(1.75, 5);
    // До конца недели (2 дня) не хватает.
    expect(stats.coversWeek).toBe(false);
  });

  it('без активаций темп неизвестен — прогноза нет, а не ноль', () => {
    const stats = weeklyPoolStats([account({ id: 1 })], [], today);
    expect(stats.perDay).toBe(0);
    expect(stats.daysLeft).toBeNull();
    expect(stats.coversWeek).toBeNull();
  });
});
