import { describe, expect, it } from 'vitest';
import {
  ACTIVATED_PREVIEW_LIMIT,
  ACTIVATION_WINDOW_HOURS,
  ACTIVATION_WINDOW_MS,
  SOON_RELEASE_WINDOW_MS,
  accountPoolSummary,
  aggregateUsage,
  availableAt,
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

describe('мультиаккаунт: сводка по запасу (заказ владельца 06.11)', () => {
  const now = new Date('2026-11-03T12:00:00Z');

  it('свободные сейчас и освобождающиеся в ближайшие полчаса', () => {
    const summary = accountPoolSummary(
      [
        // Никогда не активированный — свободен.
        row({ id: 1 }),
        // Окно истекло — свободен.
        row({ id: 2, usedOn: '2026-11-01', usedAt: '2026-11-01T06:00:00Z' }),
        // Освободится через 10 минут.
        row({ id: 3, usedOn: '2026-11-02', usedAt: '2026-11-02T12:10:00Z' }),
        // Освободится через 5 часов — это уже не «скоро».
        row({ id: 4, usedOn: '2026-11-02', usedAt: '2026-11-02T17:00:00Z' }),
      ],
      now,
    );
    expect(summary).toEqual({ free: 2, soon: 1 });
  });

  it('полчаса — граница «скоро»', () => {
    expect(SOON_RELEASE_WINDOW_MS).toBe(30 * 60 * 1000);
    // Ровно за полчаса до освобождения — ещё «скоро».
    const usedAt = '2026-11-02T11:30:00Z';
    const summary = accountPoolSummary(
      [row({ id: 1, usedOn: '2026-11-02', usedAt })],
      new Date(new Date(usedAt).getTime() + ACTIVATION_WINDOW_MS - SOON_RELEASE_WINDOW_MS),
    );
    expect(summary).toEqual({ free: 0, soon: 1 });
  });

  it('пустой список — ноль и ноль', () => {
    expect(accountPoolSummary([], now)).toEqual({ free: 0, soon: 0 });
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
