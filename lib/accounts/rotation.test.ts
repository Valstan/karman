import { describe, expect, it } from 'vitest';
import {
  ACTIVATED_PREVIEW_LIMIT,
  DAILY_RESET_HOURS,
  SOON_RELEASE_WINDOW_MS,
  accountPoolSummary,
  aggregateUsage,
  availableAt,
  dailyResetAfter,
  isSpent,
  moscowToday,
  sortAccounts,
  splitAccounts,
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
    weekUsed: 0,
    weekExhausted: false,
    weekCheckedInToday: false,
    // Свежий аккаунт: серии нет, сегодняшняя активация дала бы 400 очков, до
    // ближайшей бонусной клетки — четыре дня.
    weekPointsNext: 400,
    weekDaysToBonus: 4,
    weekStreak: 0,
    ...over,
  };
}

describe('мультиаккаунт: ночная граница вместо суток', () => {
  it('московская дата — по UTC+3, а не по времени машины', () => {
    // 2026-11-02T21:30Z — это уже 3 ноября в Москве (UTC+3).
    expect(moscowToday(new Date('2026-11-02T21:30:00Z'))).toBe('2026-11-03');
    // За час до полуночи по Москве ещё 2-е.
    expect(moscowToday(new Date('2026-11-02T20:59:00Z'))).toBe('2026-11-02');
  });

  it('часы сброса: полночь и три ночи — берём более поздний', () => {
    // Мандат владельца 15.11: «может в 12 ночи, может быть в 3 ночи, я не знаю
    // точно». Ждать дольше безопасно (бонус точно обновился и не потрачен), ждать
    // меньше — нет.
    expect(DAILY_RESET_HOURS).toEqual([0, 3]);
  });

  it('активация днём свободна с 03:00 следующих суток', () => {
    // 2026-11-03T10:00Z = 13:00 МСК 3 ноября. Ближайшие сбросы: полночь 4-го
    // (2026-11-03T21:00Z) и 03:00 4-го (2026-11-04T00:00Z). Берём поздний.
    const usedAt = '2026-11-03T10:00:00Z';
    expect(dailyResetAfter(new Date(usedAt)).toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });

  it('активация в 23:50 свободна через три часа — ночью, а не через сутки', () => {
    // Владелец: «работаешь-работаешь на аккаунте и бац в 12 часов смотришь — а у
    // него снова можно очки активировать». 23:50 МСК = 20:50Z.
    const usedAt = '2026-11-03T20:50:00Z';
    expect(dailyResetAfter(new Date(usedAt)).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    // За два часа до сброса — ещё сожжён.
    expect(isSpent({ usedAt }, new Date('2026-11-03T22:50:00Z'))).toBe(true);
    // А в 03:20 МСК — уже свободен.
    expect(isSpent({ usedAt }, new Date('2026-11-04T00:20:00Z'))).toBe(false);
  });

  it('неопределённая полоса 00:00–03:00 ждёт целые сутки', () => {
    // Активация в 01:50 МСК 4 ноября = 2026-11-03T22:50Z. Если сброс в полночь —
    // бонус обновится только в полночь 5-го; если в три ночи — в 03:00 4-го. Берём
    // более позднее, чтобы не отдать аккаунт с несброшенным бонусом.
    const usedAt = '2026-11-03T22:50:00Z';
    expect(dailyResetAfter(new Date(usedAt)).toISOString()).toBe('2026-11-04T21:00:00.000Z');
  });

  it('не использованный аккаунт свободен', () => {
    expect(isSpent({ usedAt: null }, new Date('2026-11-03T10:00:00Z'))).toBe(false);
  });

  it('availableAt — момент освобождения аккаунта', () => {
    expect(availableAt('2026-11-03T10:00:00Z')).toBe('2026-11-04T00:00:00.000Z');
    expect(availableAt(null)).toBeNull();
  });
});

describe('мультиаккаунт: сводка по запасу (заказ владельца 06.11)', () => {
  const now = new Date('2026-11-03T23:50:00Z');

  it('свободные сейчас и освобождающиеся в ближайшие полчаса', () => {
    const summary = accountPoolSummary(
      [
        // Никогда не активированный — свободен.
        row({ id: 1 }),
        // Сброс уже прошёл — свободен.
        row({ id: 2, usedOn: '2026-11-01', usedAt: '2026-11-01T06:00:00Z' }),
        // Освободится через 10 минут (сброс в 03:00 МСК 4-го).
        row({ id: 3, usedOn: '2026-11-03', usedAt: '2026-11-03T20:00:00Z' }),
        // Неопределённая полоса 00:00–03:00 — ждёт целые сутки, «скоро» не значит.
        row({ id: 4, usedOn: '2026-11-04', usedAt: '2026-11-03T23:00:00Z' }),
      ],
      now,
    );
    expect(summary).toEqual({ free: 2, soon: 1 });
  });

  it('полчаса — граница «скоро»', () => {
    expect(SOON_RELEASE_WINDOW_MS).toBe(30 * 60 * 1000);
    // Активация в 23:00 МСК 3 ноября — сброс в 03:00 МСК 4-го.
    const usedAt = '2026-11-03T20:00:00Z';
    const release = new Date('2026-11-04T00:00:00Z');
    // Ровно за полчаса до освобождения — ещё «скоро».
    const summary = accountPoolSummary(
      [row({ id: 1, usedOn: '2026-11-03', usedAt })],
      new Date(release.getTime() - SOON_RELEASE_WINDOW_MS),
    );
    expect(summary).toEqual({ free: 0, soon: 1 });
    // На минуту раньше — уже не «скоро».
    const earlier = accountPoolSummary(
      [row({ id: 1, usedOn: '2026-11-03', usedAt })],
      new Date(release.getTime() - SOON_RELEASE_WINDOW_MS - 60_000),
    );
    expect(earlier).toEqual({ free: 0, soon: 0 });
  });

  it('пустой список — ноль и ноль', () => {
    expect(accountPoolSummary([], now)).toEqual({ free: 0, soon: 0 });
  });

  it('аккаунт с исчерпанной неделей не считается свободным', () => {
    // Заказ владельца 07.11: неделя аккаунта кончилась (7 из 7) — им нельзя
    // взять, значит он не в «свободных».
    const summary = accountPoolSummary(
      [row({ id: 1 }), row({ id: 2, weekUsed: 7, weekExhausted: true })],
      now,
    );
    expect(summary).toEqual({ free: 1, soon: 0 });
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

  it('активированный 3 часа назад — ещё израсходован (вчерашняя дата не значит «свободен»)', () => {
    // 2026-11-03T09:00Z — это 3 часа назад по окну простоя (5 ч).
    expect(isSpent({ usedAt: '2026-11-03T09:00:00Z' }, now)).toBe(true);
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

  it('израсходованные внизу, между собой — свежий сверху', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, usedOn: '2026-11-03', usedAt: '2026-11-03T11:00:00Z' }),
        row({ id: 2, usedOn: '2026-11-03', usedAt: '2026-11-03T08:00:00Z' }),
        row({ id: 3, usedOn: null, usedAt: null }),
      ],
      now,
    );
    // 04.11: «чем позже активирован, тем выше он находится» — последний
    // активированный сразу под верхним слотом, а не в конце списка.
    expect(sorted.map((a) => a.id)).toEqual([3, 1, 2]);
  });

  it('порядок — по очкам: сначала активация, которая даст 1000', () => {
    // Заказ владельца 11.11: «предлагай в первую очередь те, у которых больше
    // всего активаций за цикл» — на практике это значит «сначала те, чья
    // ближайшая активация даст 1000 очков (клетка 4 или 7)».
    const sorted = sortAccounts(
      [
        row({ id: 1, weekPointsNext: 400, weekDaysToBonus: 2, weekStreak: 2 }),
        row({ id: 2, weekPointsNext: 1000, weekDaysToBonus: 1, weekStreak: 3 }),
      ],
      now,
    );
    expect(sorted.map((a) => a.id)).toEqual([2, 1]);
  });

  it('при равных очках — ближе к бонусной клетке выше', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, weekPointsNext: 400, weekDaysToBonus: 4, weekStreak: 0 }),
        row({ id: 2, weekPointsNext: 400, weekDaysToBonus: 2, weekStreak: 2 }),
        row({ id: 3, weekPointsNext: 400, weekDaysToBonus: 3, weekStreak: 1 }),
      ],
      now,
    );
    expect(sorted.map((a) => a.id)).toEqual([2, 3, 1]);
  });

  it('при равном расстоянии — длиннее серия выше', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, weekPointsNext: 400, weekDaysToBonus: 2, weekStreak: 1 }),
        row({ id: 2, weekPointsNext: 400, weekDaysToBonus: 2, weekStreak: 5 }),
      ],
      now,
    );
    expect(sorted.map((a) => a.id)).toEqual([2, 1]);
  });

  it('свежие аккаунты — в конец: новые в оборот берём по мере надобности', () => {
    const sorted = sortAccounts(
      [
        row({ id: 1, usedOn: null, usedAt: null, weekPointsNext: 400, weekDaysToBonus: 4, weekStreak: 0 }),
        row({ id: 2, usedOn: '2026-10-30', usedAt: '2026-10-30T06:00:00Z', weekPointsNext: 400, weekDaysToBonus: 2, weekStreak: 2 }),
      ],
      now,
    );
    expect(sorted.map((a) => a.id)).toEqual([2, 1]);
  });

  it('отмеченный сегодня в верхний слот не встаёт — очков сегодня всё равно 0', () => {
    // Чек-ин в сутки один: повторная активация очков не даёт. Аккаунт остаётся
    // в списке (он нужен для работы), но слот под него не тратится.
    const sorted = sortAccounts(
      [
        row({ id: 1, weekCheckedInToday: true, weekPointsNext: 0 }),
        row({ id: 2, weekPointsNext: 400, weekDaysToBonus: 4, weekStreak: 0 }),
      ],
      now,
    );
    expect(sorted.map((a) => a.id)).toEqual([2, 1]);
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

describe('мультиаккаунт: разбиение списка на экран', () => {
  const now = new Date('2026-11-03T12:00:00Z');

  it('верхний слот — один: тот, кто дольше всех не активировался', () => {
    const split = splitAccounts(
      [
        row({ id: 1, usedOn: '2026-11-03', usedAt: '2026-11-03T11:00:00Z' }),
        row({ id: 2, usedOn: null, usedAt: null }),
        row({ id: 3, usedOn: null, usedAt: null }),
      ],
      now,
    );
    // Никогда не активированные идут первыми; между собой — по id.
    expect(split.next?.id).toBe(2);
    expect(split.queued.map((a) => a.id)).toEqual([3]);
    expect(split.activated.map((a) => a.id)).toEqual([1]);
  });

  it('после активации слота его место занимает следующий свободный', () => {
    const split = splitAccounts(
      [
        row({ id: 1, usedOn: null, usedAt: null }),
        row({ id: 2, usedOn: null, usedAt: null }),
        row({ id: 3, usedOn: null, usedAt: null }),
      ],
      now,
    );
    expect(split.next?.id).toBe(1);
    // Активировали слот — он уходит в активированные, следующий встаёт наверх.
    const after = splitAccounts(
      [
        row({ id: 1, usedOn: '2026-11-03', usedAt: '2026-11-03T11:00:00Z' }),
        row({ id: 2, usedOn: null, usedAt: null }),
        row({ id: 3, usedOn: null, usedAt: null }),
      ],
      now,
    );
    expect(after.next?.id).toBe(2);
    expect(after.activated.map((a) => a.id)).toEqual([1]);
  });

  it('активированные — свежий сверху, по умолчанию показываем 10', () => {
    const accounts = Array.from({ length: 12 }, (_, i) =>
      row({
        id: i + 1,
        usedOn: '2026-11-03',
        // Чем больше минута, тем свежее активация.
        usedAt: new Date(new Date('2026-11-03T09:00:00Z').getTime() + i * 60_000).toISOString(),
      }),
    );
    const split = splitAccounts(accounts, now);
    expect(split.next).toBeNull();
    expect(split.activated.length).toBe(12);
    expect(split.activated[0]!.id).toBe(12);
    expect(split.activated.slice(0, ACTIVATED_PREVIEW_LIMIT).map((a) => a.id)).toEqual([
      12, 11, 10, 9, 8,
    ]);
    // Заказ владельца 05.11: «оставим активированных аккаунтов не 10, а 5».
    expect(ACTIVATED_PREVIEW_LIMIT).toBe(5);
  });

  it('пустой список — пустое разбиение', () => {
    const split = splitAccounts([], now);
    expect(split.next).toBeNull();
    expect(split.activated).toEqual([]);
    expect(split.queued).toEqual([]);
  });

  it('аккаунт с исчерпанной неделей не встаёт в верхний слот', () => {
    // Заказ владельца 07.11: «если на этой неделе у аккаунта уже прошло семь
    // активаций, то ты не предлагай его для активации». Он остаётся в списке
    // (со своей историей), но в верхний слот не встаёт.
    const split = splitAccounts(
      [
        row({
          id: 1,
          weekUsed: 7,
          weekExhausted: true,
          usedOn: '2026-11-03',
          usedAt: '2026-11-03T06:00:00Z',
        }),
        row({ id: 2, usedOn: null, usedAt: null }),
      ],
      now,
    );
    expect(split.next?.id).toBe(2);
    expect(split.activated.map((a) => a.id)).toEqual([1]);
    expect(split.queued.map((a) => a.id)).toEqual([]);
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
