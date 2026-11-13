import { describe, expect, it } from 'vitest';
import {
  buildOffer,
  hintFor,
  pickPoolAccount,
  resolveActivation,
  type PoolOffer,
  type PoolRow,
} from '@/lib/accounts/pool';
import { ACTIVATION_WINDOW_MS } from '@/lib/accounts/rotation';
import { weeklyQuota, type WeeklyCheckIn } from '@/lib/accounts/weekly';

const TODAY = '2026-11-13';
const NOW = new Date('2026-11-13T12:00:00Z');

/**
 * Аккаунт с НАСТОЯЩЕЙ недельной квотой: поля строки и квота считаются из одних и
 * тех же отметок, иначе подсказка («сколько очков») разойдётся с моделью, а тест
 * будет врать.
 */
function account(
  id: number,
  checkIns: WeeklyCheckIn[] = [],
  over: Partial<PoolRow> = {},
): PoolRow {
  const quota = weeklyQuota(checkIns, TODAY);
  return {
    id,
    title: `Аккаунт ${id}`,
    email: `acc${id}@example.test`,
    usedOn: checkIns.length ? checkIns[checkIns.length - 1]!.date : null,
    usedAt: null,
    projectId: null,
    projectName: null,
    lastTokens: 0,
    weekUsed: quota.used,
    weekExhausted: quota.exhausted,
    weekCheckedInToday: checkIns.some((row) => row.date === TODAY),
    weekPointsNext: quota.pointsToday,
    weekDaysToBonus: quota.daysToBonus,
    weekStreak: quota.streak,
    week: quota,
    ...over,
  };
}

/** Отметка без названного номера — как пишет программа сама. */
const auto = (date: string): WeeklyCheckIn => ({ date, index: null });

describe('пул MiniMax: раздача аккаунта проекту', () => {
  it('проекту отдаётся аккаунт на 400 очков, даже если рядом есть тысячник', () => {
    // Правило владельца 13.11: тысячные остаются владельцу (комп, программирование).
    const thousand = account(1, [auto('2026-11-10'), auto('2026-11-11'), auto('2026-11-12')]);
    const four = account(2, [auto('2026-11-12')]);
    const picked = pickPoolAccount([thousand, four], NOW);
    expect(picked.account?.id).toBe(2);
    expect(picked.tier).toBe('points_400');
  });

  it('тысячник отдаётся только когда свободных четырёхсотых не осталось', () => {
    const thousand = account(1, [auto('2026-11-10'), auto('2026-11-11'), auto('2026-11-12')]);
    const picked = pickPoolAccount([thousand], NOW);
    expect(picked.account?.id).toBe(1);
    expect(picked.tier).toBe('points_1000');
  });

  it('уже отмеченный сегодня аккаунт (0 очков) — последний резерв', () => {
    const zero = account(1, [auto('2026-11-12'), auto(TODAY)]);
    const picked = pickPoolAccount([zero], NOW);
    expect(picked.account?.id).toBe(1);
    expect(picked.tier).toBe('points_0');
  });

  it('внутри класса 400 очков действует прежний порядок: ближе к бонусу — раньше', () => {
    const near = account(1, [auto('2026-11-11'), auto('2026-11-12')]);
    const far = account(2, [auto('2026-11-12')]);
    const picked = pickPoolAccount([far, near], NOW);
    expect(picked.account?.id).toBe(1);
    expect(picked.tier).toBe('points_400');
  });

  it('занятый окном (5 ч) аккаунт не предлагается', () => {
    const usedAt = new Date(NOW.getTime() - ACTIVATION_WINDOW_MS + 60_000).toISOString();
    const busy = account(1, [auto('2026-11-12')], { usedAt, usedOn: TODAY });
    const free = account(2, [auto('2026-11-12')]);
    const picked = pickPoolAccount([busy, free], NOW);
    expect(picked.account?.id).toBe(2);
  });

  it('аккаунт с исчерпанной неделей (7 из 7) не предлагается', () => {
    const exhausted = account(1, [], { weekExhausted: true });
    const free = account(2, [auto('2026-11-12')]);
    const picked = pickPoolAccount([exhausted, free], NOW);
    expect(picked.account?.id).toBe(2);
  });

  it('пустой пул — честная пустота, а не ошибка', () => {
    const offer = buildOffer(pickPoolAccount([], NOW), { project: 'SARAFAN', today: TODAY });
    expect(offer.account).toBeNull();
    expect(offer.reason).toBe('no_free_accounts');
    expect(offer.tier).toBeNull();
    expect(offer.recommended).toBe(false);
    expect(offer.free).toBe(0);
    expect(offer.project).toBe('SARAFAN');
  });

  it('в ответе — почта, клетка и сколько очков ждать; пароля нет', () => {
    const offer: PoolOffer = buildOffer(pickPoolAccount([account(7, [auto('2026-11-12')])], NOW), {
      project: 'SARAFAN',
      today: TODAY,
    });
    expect(offer.account?.email).toBe('acc7@example.test');
    expect(offer.account?.activation_index).toBe(2);
    expect(offer.account?.points_next).toBe(400);
    expect(offer.recommended).toBe(true);
    expect(offer.why).toContain('400 очков');
    // Пароля в ответе нет: Сарафан работает по почте, секрет наружу не выносим.
    expect('password' in (offer.account ?? {})).toBe(false);
  });
});

describe('пул MiniMax: подсказка по очкам', () => {
  it('если владелец называл клетку — считаем от ЕГО числа (панель — истина)', () => {
    // Вчера на панели было 3 → сегодня 4-я клетка → 1000 очков.
    // Модель по датам сказала бы 2-ю клетку (400) — очки сгорели бы вхолостую.
    const row = account(1, [{ date: '2026-11-12', index: 3 }]);
    const hint = hintFor(row);
    expect(hint.source).toBe('owner_confirmed');
    expect(hint.index).toBe(4);
    expect(hint.points).toBe(1000);
  });

  it('если владелец не называл — считаем по модели, как раньше', () => {
    const hint = hintFor(account(1, [auto('2026-11-12')]));
    expect(hint.source).toBe('model');
    expect(hint.index).toBe(2);
    expect(hint.points).toBe(400);
  });

  it('после пропущенного дня серия мертва — подсказка по модели (клетка 1)', () => {
    const hint = hintFor(account(1, [{ date: '2026-11-10', index: 3 }]));
    expect(hint.source).toBe('model');
    expect(hint.index).toBe(1);
    expect(hint.points).toBe(400);
  });

  it('аккаунт под вопросом (3@) — подсказки по очкам нет вовсе', () => {
    const hint = hintFor(account(86, [auto('2026-11-12')]));
    expect(hint.unverified).toBe(true);
    expect(hint.points).toBeNull();

    const picked = pickPoolAccount([account(86, [auto('2026-11-12')])], NOW);
    expect(picked.tier).toBe('unverified');
  });

  it('чек-ин за сегодня уже был — очков сегодня не будет ни при какой клетке', () => {
    const hint = hintFor(account(1, [auto('2026-11-12'), auto(TODAY)]));
    expect(hint.points).toBe(0);
  });
});

describe('пул MiniMax: фильтры запроса', () => {
  it('exclude — аккаунт, который проекту не подошёл, уходит', () => {
    const first = account(1, [auto('2026-11-12')]);
    const second = account(2, [auto('2026-11-12')]);
    const picked = pickPoolAccount([first, second], NOW, { excludeIds: [1] });
    expect(picked.account?.id).toBe(2);
  });

  it('emails — отдаём только те аккаунты, чьи почты у проекта есть', () => {
    const mine = account(1, [auto('2026-11-12')]);
    const alien = account(2, [auto('2026-11-12')]);
    const picked = pickPoolAccount([mine, alien], NOW, { emails: ['ACC1@example.test'] });
    expect(picked.account?.id).toBe(1);
  });

  it('почта сравнивается без учёта регистра', () => {
    const mine = account(1, [auto('2026-11-12')]);
    const picked = pickPoolAccount([mine], NOW, { emails: ['acc1@EXAMPLE.test'] });
    expect(picked.account?.id).toBe(1);
  });

  it('под фильтр ничего не подошло — честная пустота', () => {
    const picked = pickPoolAccount([account(1, [auto('2026-11-12')])], NOW, {
      emails: ['other@example.test'],
    });
    expect(picked.account).toBeNull();
  });
});

describe('пул MiniMax: запись активации по ответу проекта', () => {
  const quota = weeklyQuota([auto('2026-11-12')], TODAY);

  it('назвал клетку — очки считаются по ней (4-я и 7-я — 1000)', () => {
    const resolution = resolveActivation({ activationIndex: 4 }, quota, { points: 1000, index: 4 });
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
    const resolution = resolveActivation({ activationIndex: 1 }, quota, { points: 400, index: 2 });
    expect(resolution.index).toBe(1);
    expect(resolution.points).toBe(400);
    expect(resolution.mismatch).toBe(true);
  });
});
