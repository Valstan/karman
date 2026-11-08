import { describe, expect, it } from 'vitest';
import {
  WEEKLY_ACTIVATION_LIMIT,
  WEEKLY_ACTIVATION_POINTS,
  WEEKLY_POINTS_TOTAL,
  cycleDayNumber,
  moscowWeekStart,
  pointsForIndex,
  weeklyPoolStats,
  weeklyQuota,
  type WeeklyAccountInput,
  type WeeklyCheckIn,
} from '@/lib/accounts/weekly';

/** Чек-ин аккаунта: дата и (необязательно) номер активации. */
function checkIn(date: string, index: number | null = null): WeeklyCheckIn {
  return { date, index };
}

describe('недельная квота MiniMax: очки по номеру активации', () => {
  it('4-я и 7-я активации дают 1000, остальные — 400', () => {
    // Ровно то, что в документации MiniMax (400 в обычный день, 1000 в 4-й
    // и 7-й), и это даёт 4000 за полную неделю.
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
});

describe('недельная квота MiniMax: номер активации — календарный день окна', () => {
  const today = '2026-11-08';

  it('никогда не активировавшийся аккаунт: первая активация — первая в неделе', () => {
    const quota = weeklyQuota([], today);
    expect(quota.anchorDate).toBeNull();
    expect(quota.used).toBe(0);
    expect(quota.nextIndex).toBe(1);
    expect(quota.exhausted).toBe(false);
    expect(quota.remaining).toBe(WEEKLY_ACTIVATION_LIMIT);
    expect(quota.pointsLeft).toBe(4000);
  });

  it('номер — позиция дня в неделе, а НЕ число строк журнала', () => {
    // Ключевая правка 08.11: раньше номер считался как «строк в журнале + 1»,
    // из-за чего после пропущенного дня счёт уезжал и программа показывала
    // 1000 очков вместо 400.
    const quota = weeklyQuota(
      [checkIn('2026-11-04'), checkIn('2026-11-05'), checkIn('2026-11-06')],
      today,
    );
    // Неделя аккаунта: 04.11 — день 1, 08.11 — день 5.
    expect(quota.cycle.startDate).toBe('2026-11-04');
    expect(quota.nextIndex).toBe(5);
    expect(pointsForIndex(quota.nextIndex!)).toBe(400);
  });

  it('пропущенный день не сбивает нумерацию клеток', () => {
    // 07.11 пропущен: клетки 1,2,3 заняты, 4-я (1000) сгорела, 08.11 — клетка 5.
    const quota = weeklyQuota(
      [checkIn('2026-11-04'), checkIn('2026-11-05'), checkIn('2026-11-06')],
      '2026-11-08',
    );
    expect(quota.nextIndex).toBe(5);
    expect(quota.used).toBe(3);
    // Осталось отметить 08, 09, 10 — клетки 5, 6, 7.
    expect(quota.remaining).toBe(3);
    expect(quota.pointsLeft).toBe(400 + 400 + 1000);
  });

  it('все семь дней отработаны → неделя исчерпана, аккаунт не предлагается', () => {
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

  it('неделя простоя прошла → следующее использование открывает НОВОЕ окно', () => {
    // Документация MiniMax: «when a window ends, your next use starts a new
    // window». Окно 04..10, потом тишина, и 12.11 — уже новое окно, день 1.
    const quota = weeklyQuota([checkIn('2026-11-04')], '2026-11-12');
    expect(quota.cycle.startDate).toBe('2026-11-12');
    expect(quota.used).toBe(0);
    expect(quota.nextIndex).toBe(1);
    expect(quota.exhausted).toBe(false);
  });

  it('уточнение владельца выправляет нумерацию: дальше считаем от его номера', () => {
    // Журнал начат 04.11, а настоящее окно аккаунта могло начаться раньше —
    // тогда наша нумерация отстаёт. Владелец называет настоящий номер (4) за
    // 07.11, и программа дальше считает от него: окно 04..10, 09.11 — клетка 6.
    const quota = weeklyQuota(
      [checkIn('2026-11-06', 3), checkIn('2026-11-07', 4)],
      '2026-11-09',
    );
    expect(quota.confirmedIndex).toBe(4);
    expect(quota.cycle.startDate).toBe('2026-11-04');
    expect(quota.nextIndex).toBe(6);
  });

  it('уточнение владельца из ПРОШЛОГО окна не влияет на текущее', () => {
    // 01.11 — конец прошлой недели, 09.11 аккаунт открыл новую (окно недели
    // длится 7 дней от первого использования). Уточнение по 01.11 к новой
    // неделе отношения не имеет.
    const quota = weeklyQuota([checkIn('2026-11-01', 4), checkIn('2026-11-09')], '2026-11-09');
    expect(quota.cycle.startDate).toBe('2026-11-09');
    expect(quota.confirmedIndex).toBeNull();
    // Отмечена первая клетка новой недели, следующая активация — 10.11, вторая.
    expect(quota.nextIndex).toBe(2);
  });

  it('чек-ины вне текущего окна в счёт не идут', () => {
    const quota = weeklyQuota(
      [
        checkIn('2026-11-01'),
        checkIn('2026-11-02'),
        checkIn('2026-11-03'),
        checkIn('2026-11-05'),
      ],
      today,
    );
    // Окно 01..07 кончилось, 08.11 — ближайшее использование, новое окно.
    expect(quota.cycle.startDate).toBe('2026-11-08');
    expect(quota.used).toBe(0);
    expect(quota.nextIndex).toBe(1);
  });

  it('старое авто-значение из журнала не выправляет неделю', () => {
    // 07.11–08.11 журнал писала сломанная формула: номер = «строка в цикле».
    // Именно она уводила программу на клетку «4-я» (1000 очков) — владелец и
    // жаловался. Такие значения в счёт не идут: неделя считается по календарю.
    const quota = weeklyQuota(
      [
        checkIn('2026-11-04', 1),
        checkIn('2026-11-05', 2),
        checkIn('2026-11-06', 3),
        checkIn('2026-11-08', 4),
      ],
      '2026-11-08',
    );
    expect(quota.confirmedIndex).toBeNull();
    expect(quota.cycle.startDate).toBe('2026-11-04');
    // Сегодняшний день — 5-я клетка (окно с 04.11), а не 4-я: 1000 не
    // начисляется.
    expect(cycleDayNumber(quota.cycle, '2026-11-08')).toBe(5);
    expect(quota.nextIndex).toBe(6);
    expect(pointsForIndex(quota.nextIndex!)).toBe(400);
  });

  it('номер, названный владельцем, — выправляет неделю', () => {
    // Тот же журнал, но владелец назвал настоящий номер (6) — программа считает
    // от него: окно началось 03.11, 08.11 — клетка 6, завтра — клетка 7.
    const quota = weeklyQuota(
      [
        checkIn('2026-11-04', 1),
        checkIn('2026-11-05', 2),
        checkIn('2026-11-06', 3),
        checkIn('2026-11-08', 6),
      ],
      '2026-11-08',
    );
    expect(quota.confirmedIndex).toBe(6);
    expect(quota.cycle.startDate).toBe('2026-11-03');
    expect(quota.nextIndex).toBe(7);
    expect(pointsForIndex(quota.nextIndex!)).toBe(1000);
  });

  it('понедельник московской недели — для темпа и прогноза', () => {
    // 2026-11-07 — суббота.
    expect(moscowWeekStart('2026-11-07')).toBe('2026-11-02');
    // Понедельник сам по себе.
    expect(moscowWeekStart('2026-11-02')).toBe('2026-11-02');
  });
});

describe('недельная квота MiniMax: сводка по запасу', () => {
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
        account({
          id: 5,
          quota: weeklyQuota(
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
          ),
        }),
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
    // У первого окно 05.11: отмечен один день, осталось 07..11 (5 клеток);
    // у второго — все семь. Итого 12 активаций.
    expect(stats.week).toBe(12);
    // Очки за оставшиеся клетки: у первого клетки 3..7 (3200), у второго 1..7
    // (4000).
    expect(stats.weekPoints).toBe(3200 + 4000);
  });

  it('темп считается по текущей московской неделе, прогноз — «хватит ли до конца»', () => {
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
