import { describe, expect, it } from 'vitest';
import {
  buildOffer,
  pickPoolAccount,
  resolveActivation,
  type PoolOffer,
} from '@/lib/accounts/pool';
import type { AccountRotationRow } from '@/lib/accounts/rotation';
import { ACTIVATION_WINDOW_MS } from '@/lib/accounts/rotation';
import { weeklyQuota } from '@/lib/accounts/weekly';

/** Строка аккаунта для теста: по умолчанию свежий, 400 очков, до бонуса 4 дня. */
function row(over: Partial<AccountRotationRow> & { id: number }): AccountRotationRow {
  return {
    title: `Аккаунт ${over.id}`,
    email: `acc${over.id}@example.test`,
    usedOn: null,
    usedAt: null,
    projectId: null,
    projectName: null,
    lastTokens: 0,
    weekUsed: 0,
    weekExhausted: false,
    weekCheckedInToday: false,
    weekPointsNext: 400,
    weekDaysToBonus: 4,
    weekStreak: 0,
    ...over,
  };
}

const NOW = new Date('2026-11-13T12:00:00Z');

describe('пул MiniMax: раздача аккаунта проекту', () => {
  it('проекту отдаётся аккаунт на 400 очков, даже если рядом есть тысячник', () => {
    // Правило владельца 13.11: тысячные остаются владельцу (комп, программирование).
    const picked = pickPoolAccount(
      [
        row({ id: 1, weekPointsNext: 1000, weekDaysToBonus: 1 }),
        row({ id: 2, weekPointsNext: 400, weekDaysToBonus: 4 }),
      ],
      NOW,
    );
    expect(picked.account?.id).toBe(2);
    expect(picked.tier).toBe('points_400');
  });

  it('тысячник отдаётся только когда свободных четырёхсотых не осталось', () => {
    const picked = pickPoolAccount([row({ id: 1, weekPointsNext: 1000 })], NOW);
    expect(picked.account?.id).toBe(1);
    expect(picked.tier).toBe('points_1000');
  });

  it('уже отмеченный сегодня аккаунт (0 очков) — последний резерв', () => {
    const picked = pickPoolAccount([row({ id: 1, weekPointsNext: 0, weekCheckedInToday: true })], NOW);
    expect(picked.account?.id).toBe(1);
    expect(picked.tier).toBe('points_0');
  });

  it('внутри класса 400 очков действует прежний порядок: ближе к бонусу — раньше', () => {
    const picked = pickPoolAccount(
      [
        row({ id: 1, weekPointsNext: 400, weekDaysToBonus: 4 }),
        row({ id: 2, weekPointsNext: 400, weekDaysToBonus: 1 }),
      ],
      NOW,
    );
    expect(picked.account?.id).toBe(2);
    expect(picked.tier).toBe('points_400');
  });

  it('занятый окном (5 ч) аккаунт не предлагается', () => {
    const usedAt = new Date(NOW.getTime() - ACTIVATION_WINDOW_MS + 60_000).toISOString();
    const picked = pickPoolAccount(
      [row({ id: 1, usedAt, usedOn: '2026-11-13', weekPointsNext: 400 }), row({ id: 2 })],
      NOW,
    );
    expect(picked.account?.id).toBe(2);
    expect(picked.free).toBe(1);
  });

  it('аккаунт с исчерпанной неделей (7 из 7) не предлагается', () => {
    const picked = pickPoolAccount(
      [row({ id: 1, weekExhausted: true, weekPointsNext: 400 }), row({ id: 2 })],
      NOW,
    );
    expect(picked.account?.id).toBe(2);
    expect(picked.free).toBe(1);
  });

  it('отмеченный сегодня (очки 0) уходит вниз: бонус в холостую — не берём', () => {
    const picked = pickPoolAccount(
      [
        row({ id: 1, weekCheckedInToday: true, weekPointsNext: 0 }),
        row({ id: 2, weekPointsNext: 400 }),
      ],
      NOW,
    );
    expect(picked.account?.id).toBe(2);
  });

  it('пустой пул — честная пустота, а не ошибка', () => {
    const offer = buildOffer(pickPoolAccount([], NOW), {
      password: null,
      quota: null,
      project: 'SARAFAN',
      today: '2026-11-13',
    });
    expect(offer.account).toBeNull();
    expect(offer.reason).toBe('no_free_accounts');
    expect(offer.tier).toBeNull();
    expect(offer.free).toBe(0);
    expect(offer.project).toBe('SARAFAN');
  });

  it('в ответе — почта, пароль, клетка и сколько очков ждать', () => {
    // Отмечен вчера (12.11) → серия длиной 1 → сегодня вторая клетка, 400 очков.
    const quota = weeklyQuota([{ date: '2026-11-12', index: 3 }], '2026-11-13');
    const account = row({
      id: 7,
      weekPointsNext: quota.pointsToday,
      weekDaysToBonus: quota.daysToBonus,
      weekStreak: quota.streak,
    });
    const offer: PoolOffer = buildOffer(pickPoolAccount([account], NOW), {
      password: 'секретный-пароль',
      quota,
      project: 'SARAFAN',
      today: '2026-11-13',
    });
    expect(offer.account).not.toBeNull();
    expect(offer.account?.email).toBe('acc7@example.test');
    expect(offer.account?.password).toBe('секретный-пароль');
    expect(offer.account?.activation_index).toBe(2);
    expect(offer.account?.points_next).toBe(400);
    expect(offer.account?.streak).toBe(1);
    expect(offer.account?.next_bonus_in_days).toBe(quota.daysToBonus);
    expect(offer.tier).toBe('points_400');
  });
});

describe('пул MiniMax: запись активации по ответу проекта', () => {
  const quota = weeklyQuota([{ date: '2026-11-12', index: 3 }], '2026-11-13');

  it('назвал клетку — очки считаются по ней (4-я и 7-я — 1000)', () => {
    const resolution = resolveActivation({ activationIndex: 4 }, quota, {
      points: 1000,
      index: 4,
    });
    expect(resolution.index).toBe(4);
    expect(resolution.points).toBe(1000);
    expect(resolution.source).toBe('client_index');
    expect(resolution.mismatch).toBe(false);
  });

  it('прислал очки без клетки — записываем факт, клетку считаем сами', () => {
    const resolution = resolveActivation({ points: 1000 }, quota, { points: 400, index: 2 });
    expect(resolution.points).toBe(1000);
    expect(resolution.source).toBe('client_points');
    expect(resolution.index).toBe(2);
    // Факт разошёлся с предсказанием — это сигнал, а не повод «поправить» модель.
    expect(resolution.mismatch).toBe(true);
  });

  it('ничего не прислал — считаем сами по недельной квоте', () => {
    const resolution = resolveActivation({}, quota, { points: 400, index: 2 });
    expect(resolution.index).toBe(2);
    expect(resolution.points).toBe(400);
    expect(resolution.source).toBe('computed');
  });

  it('клетка проекта важнее нашего предсказания: расхождение помечается, но не правится', () => {
    // Мы ждали клетку 2 (400 очков), проект прислал клетку 1 — записываем его
    // показание (истина — панель), но помечаем расхождение.
    const resolution = resolveActivation({ activationIndex: 1 }, quota, {
      points: 400,
      index: 2,
    });
    expect(resolution.index).toBe(1);
    expect(resolution.points).toBe(400);
    expect(resolution.mismatch).toBe(true);
  });
});
