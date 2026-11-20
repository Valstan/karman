import { describe, expect, it } from 'vitest';
import {
  availableCount,
  buildOffer,
  pickPoolAccount,
  resolveActivation,
  tierOfPoints,
  type ClaimFact,
  type PoolOffer,
  type PoolRow,
} from '@/lib/accounts/pool';
import { weeklyQuota, type WeeklyCheckIn } from '@/lib/accounts/weekly';
import { accountPoolSummary } from '@/lib/accounts/rotation';

const TODAY = '2026-11-13';
const NOW = new Date('2026-11-13T12:00:00Z');

/**
 * Аккаунт с НАСТОЯЩЕЙ недельной квотой: поля строки и квота считаются из одних и
 * тех же отметок, иначе тест будет врать.
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
    // Момент последней активации — по последней отметке: порядок выдачи решает
    // давность (мандат владельца 15.11).
    usedAt: checkIns.length ? `${checkIns[checkIns.length - 1]!.date}T09:00:00.000Z` : null,
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

/** Ответ вендора на забор при выдаче: клетка и номинал — факт, а не прогноз. */
function fact(over: Partial<ClaimFact> = {}): ClaimFact {
  return { index: 3, points: 400, result: 1, claimId: 'claim-1', ...over };
}

describe('пул MiniMax: одна карусель (заказ владельца 20.11)', () => {
  it('разделения на 400 и 1000 нет: отдаётся первый в общей очереди', () => {
    // Раньше тысячные уходили только программированию, а продсерверу шла
    // четырёхсотковая каруселя. Теперь карусель одна (заказ владельца 20.11:
    // «сделай одну карусель без разделения… выдавай всем просто то что есть»).
    const thousand = account(1, [], {
      usedAt: '2026-11-11T09:00:00.000Z',
      bonusOurs: true,
      bonusPoints: 1000,
      bonusDayNo: 4,
    });
    const four = account(2, [], {
      usedAt: '2026-11-12T09:00:00.000Z',
      bonusOurs: true,
      bonusPoints: 400,
      bonusDayNo: 2,
    });
    const picked = pickPoolAccount([four, thousand], NOW);
    // Давность решает: тысячник давно не выдавали — он и идёт первым.
    expect(picked.account?.id).toBe(1);
  });

  it('в очереди — по времени последней выдачи, никогда не выданный первый', () => {
    const old = account(1, [], { usedAt: '2026-11-10T09:00:00.000Z' });
    const fresh = account(2, [], { usedAt: '2026-11-12T09:00:00.000Z' });
    const never = account(3, []);
    const picked = pickPoolAccount([fresh, old, never], NOW);
    expect(picked.account?.id).toBe(3);
  });

  it('клетку забрал потребитель — аккаунт уходит в конец очереди, но не исчезает', () => {
    // Очки такого аккаунта потрачены: забор при выдаче его отсечёт (claim_result = 2
    // и клетка не наша). Но из пула он НЕ выпадает — ждёт следующих суток в хвосте.
    const dead = account(1, [], { usedAt: '2026-11-10T09:00:00.000Z', bonusOurs: false });
    const live = account(2, [], { usedAt: '2026-11-11T09:00:00.000Z', bonusOurs: true });
    const picked = pickPoolAccount([dead, live], NOW);
    expect(picked.account?.id).toBe(2);
  });

  it('занятый аккаунт (открытая сессия) не предлагается', () => {
    // Ночной сброс после активации ещё не наступил — аккаунт в работе.
    const usedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
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

  it('аккаунт, который владелец включил вручную, проекту не отдаётся', () => {
    const held = account(1, [], { ownerUsedAt: NOW.toISOString() });
    const free = account(2, [auto('2026-11-12')]);
    const picked = pickPoolAccount([held, free], NOW);
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

  it('в ответе — почта, клетка и очки из ФАКТА забора; пароля нет', () => {
    const offer: PoolOffer = buildOffer(pickPoolAccount([account(7, [auto('2026-11-12')])], NOW), {
      project: 'SARAFAN',
      today: TODAY,
      fact: fact({ index: 4, points: 1000 }),
    });
    expect(offer.account?.email).toBe('acc7@example.test');
    // Клетка и номинал — из ответа вендора на забор, а не из модели по датам.
    expect(offer.account?.activation_index).toBe(4);
    expect(offer.account?.points_next).toBe(1000);
    expect(offer.account?.unverified).toBe(false);
    expect(offer.tier).toBe('points_1000');
    expect(offer.recommended).toBe(true);
    expect(offer.why).toContain('1000 очков');
    // Пароля в ответе нет: Сарафан работает по почте, секрет наружу не выносим.
    expect('password' in (offer.account ?? {})).toBe(false);
  });

  it('без факта забора очки не обещаем: клетка и номинал — null', () => {
    const offer = buildOffer(pickPoolAccount([account(7, [auto('2026-11-12')])], NOW), {
      project: 'SARAFAN',
      today: TODAY,
    });
    expect(offer.account?.activation_index).toBeNull();
    expect(offer.account?.points_next).toBeNull();
  });

  it('класс очков — по номиналу клетки', () => {
    expect(tierOfPoints(1000)).toBe('points_1000');
    expect(tierOfPoints(400)).toBe('points_400');
    expect(tierOfPoints(null)).toBe('points_0');
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

  it('без добытой пары токенов аккаунт не отдаётся: причиной — «токены не готовы»', () => {
    // Вход в MiniMax делает владелец, пароля у проекта нет — аккаунт без пары
    // проекту бесполезен, значит и отдавать его нельзя.
    const one = account(1, [auto('2026-11-12')]);
    const picked = pickPoolAccount([one], NOW, { tokenReadyIds: [] });
    expect(picked.account).toBeNull();
    expect(picked.reason).toBe('no_tokens_ready');
  });

  it('из всех аккаунтов берётся тот, у кого пара есть', () => {
    const withoutToken = account(1, [auto('2026-11-12')]);
    const withToken = account(2, [auto('2026-11-12')]);
    const picked = pickPoolAccount([withoutToken, withToken], NOW, { tokenReadyIds: [2] });
    expect(picked.account?.id).toBe(2);
  });

  it('если в пуле вовсе нет свободных — причина «нет свободных»', () => {
    const spent = account(1, [auto('2026-11-12')], {
      usedAt: NOW.toISOString(),
      usedOn: TODAY,
    });
    const picked = pickPoolAccount([spent], NOW, { tokenReadyIds: [1] });
    expect(picked.account).toBeNull();
    expect(picked.reason).toBe('no_free_accounts');
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

/**
 * Счётчик для кнопки выдачи: одна карусель — одно число (заказ владельца 20.11).
 *
 * Очки здесь НЕ проверяются: их проверяет забор в момент выдачи. Проверять их
 * заранее было бессмысленно — панель остатка не отдаёт, а модель клетки с вендором
 * расходилась у 274 строк леджера из 416.
 */
describe('пул MiniMax: сколько аккаунтов готовы к выдаче', () => {
  it('считаем всех доступных, а не по классам очков', () => {
    const four = account(1, [auto('2026-11-12')], { bonusOurs: true, bonusPoints: 400 });
    const thousand = account(2, [auto('2026-11-12')], { bonusOurs: true, bonusPoints: 1000 });
    const exhausted = account(3, [auto('2026-11-12')], { weekExhausted: true });
    expect(availableCount([four, thousand, exhausted], NOW, [1, 2, 3])).toBe(2);
    // Без пары токенов отдавать нечего (вход в MiniMax делает владелец).
    expect(availableCount([four, thousand], NOW, [1])).toBe(1);
  });

  it('занятый аккаунт в счёт не идёт', () => {
    const usedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const busy = account(1, [auto('2026-11-12')], { usedAt, usedOn: TODAY });
    expect(availableCount([busy], NOW, [1])).toBe(0);
  });
});

/**
 * Леджер забора: чьи очки лежат на аккаунте.
 *
 * Панель остатка НЕ показывает: `points` клетки — её НОМИНАЛ (400 или 1000),
 * а не «сколько осталось». Единственный верный признак — ответ вендора на забор.
 */
describe('пул MiniMax: леджер забора в порядке очереди', () => {
  it('забрали мы — аккаунт в обороте и идёт по общей очереди', () => {
    const row = account(1, [auto('2026-11-12')], {
      bonusRemaining: 1000,
      bonusPoints: 1000,
      bonusDayNo: 4,
      bonusOurs: true,
    });
    const picked = pickPoolAccount([row], NOW);
    expect(picked.account?.id).toBe(1);
    expect(picked.free).toBe(1);
  });

  it('забрал потребитель — очки потрачены: аккаунт ждёт в хвосте очереди', () => {
    // Из выдачи он не выпадает (очки проверяет забор при выдаче), но и в начало
    // очереди не встаёт — очки прежнего потребителя могли быть потрачены.
    const row = account(1, [auto('2026-11-12')], {
      bonusRemaining: 1000,
      bonusPoints: 1000,
      bonusDayNo: 4,
      bonusOurs: false,
    });
    const picked = pickPoolAccount([row], NOW);
    expect(picked.account?.id).toBe(1);
  });

  it('счётчик свободных считает аккаунты карусели', () => {
    // Активирован двое суток назад: сессия (окно после активации) истекла, аккаунт
    // снова в карусели. Панель при этом ничего не говорит — очки проверяет забор.
    const usedAt = new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const returned = account(1, [auto('2026-11-12')], {
      usedAt,
      usedOn: '2026-11-12',
    });
    const summary = accountPoolSummary([returned], NOW, { pointsMatter: false });
    expect(summary.free).toBe(1);
    expect(summary.soon).toBe(0);
  });

  it('аккаунт с открытой сессией (работает) в счётчик не идёт', () => {
    const usedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const busy = account(1, [auto('2026-11-12')], { usedAt, usedOn: TODAY });
    expect(accountPoolSummary([busy], NOW, { pointsMatter: false }).free).toBe(0);
  });
});
