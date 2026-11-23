/**
 * «Текучка» — блок про ПОТОК аккаунтов MultiMax (заказ владельца 23.11).
 *
 * ## Задача
 *
 * «На странице “Минимакс” добавь статистику в раздел “Текучка”: сколько всего
 * аккаунтов в системе, сколько потрачено сегодня, сколько осталось, и список
 * последних 10 аккаунтов — кому отдали, какому проекту и сколько очков на нём
 * активировали».
 *
 * ## Почему модуль чистый, а данные тянет сервис
 *
 * Модуль читает клиентский компонент страницы, поэтому здесь не должно быть
 * ничего, что тянет Node-модули (иначе сборка клиентского бандла падает на `pg`).
 * Сама выборка — в `lib/services/minimax-traffic.ts`; числа, которые считаются
 * по списку аккаунтов (сколько готовы к выдаче), — тоже здесь, потому что список
 * уже загружен страницей.
 *
 * ## Окно «сегодня»
 *
 * Окно — **операционные сутки 05:00 → 05:00 МСК**, ровно то, что у блока
 * «Пул и бонусы» (`operationalBonusStats`). Причина: сутки Кармана начинаются
 * в 05:00 — в этот момент утренний обход забирает бонус по всем аккаунтам, и
 * с этого момента очки на них свежие (заказ владельца 21.11). Календарная дата
 * МСК в ночные часы (00:00–05:00) показывала «почти пустой новый день», и
 * владелец цифры не узнавал.
 *
 * ## Что означает «потрачено»
 *
 * Аккаунт, чьи очки за сутки сгорели: очки либо **выдали** (мы отдали аккаунт
 * потребителю или владельцу), либо **сгорели у потребителя** (клетку забрал он
 * сам, мимо нас). Третий случай — ручная активация владельцем кнопкой
 * «Активировать»: она пишется в журнал активаций, но НЕ в леджер бонусов, и
 * поэтому видна отдельной группой («вручную»). Считать её или нет — вопрос к
 * владельцу; пока она показана отдельно и не прячется.
 */

import { isSpent, isUnavailable } from './rotation';
import type { PoolLine } from './pool-stats';
import { plural } from './pool-stats';

/** Одна выдача в списке «последние 10». */
export type TrafficIssue = {
  /** Когда отдали (ISO). */
  at: string;
  /** id аккаунта в базе владельца (null — из старых строк аудита). */
  accountId: number | null;
  /** Своя метка владельца («Матрица РМЗ — 12»). */
  title: string | null;
  /** Комната-потребитель: кому отдали (slug комнаты). */
  room: string | null;
  /** Проект потребителя — «на что ушли очки» (заголовок X-MiniMax-Project). */
  project: string | null;
  /** Область потребителя (заголовок X-MiniMax-Area). */
  area: string | null;
  /** Сколько очков нёс аккаунт в момент выдачи. */
  points: number | null;
  /** Выдал владелец (а не комната-потребитель). */
  owner: boolean;
};

/** Свод блока «Текучка». */
export type TrafficStats = {
  /** Подпись окна суток: '21.11 → 22.11'. */
  label: string;
  /** Сколько аккаунтов в системе (пул целиком, не только выданные). */
  total: number;
  /** Сколько аккаунтов потрачено за операционные сутки. */
  spent: number;
  /** Сколько из них отдали (мы — потребителям или владельцу). */
  handed: number;
  /** Сколько очков ушло вместе с отданными аккаунтами. */
  handedPoints: number;
  /** Сколько клеток забрал потребитель мимо нас (очки сгорели у него). */
  consumerTaken: number;
  /** Сколько аккаунтов активировано вручную (журнал) и в леджере не учтено. */
  manual: number;
  /** Последние выдачи — свежие сверху. */
  recent: TrafficIssue[];
};

/** Разобранная строка аудита выдачи (`minimax_account_issued`). */
export type IssueDetail = {
  /** id аккаунта. */
  accountId: number | null;
  /** Своя метка владельца. */
  title: string | null;
  /** Сколько очков нёс аккаунт. */
  points: number | null;
  /** Клетка вендора (1..7). */
  cell: number | null;
  /** Класс очков (`points_400` / `points_1000`). */
  tier: string | null;
  /** Область потребителя. */
  area: string | null;
  /** Проект потребителя. */
  project: string | null;
};

const ACCOUNT_RE = /аккаунт #(\d+)/;
const TITLE_RE = /«([^»]*)»/;
const POINTS_RE = /очки (\d+)/;
const CELL_RE = /клетка (\d+)/;
const TIER_RE = /класс ([a-z0-9_]+)/;
// Область и проект идут в конце строки, после «access отдан», — и только там.
// Без этого «проект» поймал бы слово из метки аккаунта.
const AREA_RE = /, область ([^,]+)/;
const PROJECT_RE = /, проект ([^,]+)/;

/**
 * Разобрать строку аудита выдачи.
 *
 * Формат строки (пишет `lib/services/minimax.ts`):
 *
 * `выдан аккаунт #153 «Матрица РМЗ — 12»: класс points_1000, клетка 7,
 *  очки 1000 (забор при выдаче, claim 1), access отдан, область programming,
 *  проект MatricaRMZ, жизнь access 720 мин`
 *
 * Разбор регуляркой, а не новой колонкой: строки аудита — источник правды о
 * выдачах, и их формат менялся вместе с правилами выдачи. Пропущенное поле — не
 * ошибка, а «не знаем» (`null`): старые строки аудита очков не содержали.
 */
export function parseIssueDetail(detail: string | null): IssueDetail {
  const text = detail ?? '';
  const num = (re: RegExp): number | null => {
    const match = re.exec(text);
    if (!match || match[1] === undefined) return null;
    return Number(match[1]);
  };
  const str = (re: RegExp): string | null => {
    const match = re.exec(text);
    if (!match || match[1] === undefined) return null;
    return match[1].trim();
  };
  return {
    accountId: num(ACCOUNT_RE),
    title: str(TITLE_RE),
    points: num(POINTS_RE),
    cell: num(CELL_RE),
    tier: str(TIER_RE),
    area: str(AREA_RE),
    project: str(PROJECT_RE),
  };
}

/** Аккаунт в том виде, в котором его считает счётчик «осталось». */
export type IssuableAccount = {
  id: number;
  /** Момент начала сессии активации (ISO) или null. */
  usedAt: string | null;
  /** Исчерпана ли неделя аккаунта (7 из 7). */
  weekExhausted?: boolean;
  /** Статус сегодняшней клетки по панели MiniMax: 2 — есть очки, 3 — сожжены. */
  panelStatus?: number | null;
  /** Остаток очков по нашему леджеру бонусов. */
  bonusRemaining?: number | null;
  /** Забрали ли сегодняшнюю клетку МЫ. */
  bonusOurs?: boolean | null;
  /** Когда аккаунт отдали потребителю (леджер) или null. */
  bonusHandedAt?: string | null;
  /** Когда забрали сегодняшний бонус (ISO) или null. */
  bonusClaimedAt?: string | null;
  /** Когда владелец включал аккаунт вручную (ISO) или null. */
  ownerUsedAt?: string | null;
};

/** Сколько аккаунтов можно выдать прямо сейчас. */
export type IssuableCounts = {
  /**
   * Готовы к выдаче — ровно те же правила, что у кнопки «Выдать аккаунт»:
   * не заняты сессией, неделя не исчерпана, добыта пара токенов.
   */
  ready: number;
  /**
   * Из них — с целыми очками (панель/леджер): их можно отдать потребителю
   * вместе с очками. Очки при выдаче проверяет забор, но наличие очков видно
   * уже сейчас, и владельцу нужны оба числа.
   */
  withPoints: number;
};

/**
 * Сколько аккаунтов можно выдать сейчас.
 *
 * `ready` считается по тем же правилам, что и кнопка выдачи (`availableCount` в
 * `lib/accounts/pool.ts`): занятые сессией и с исчерпанной неделей в счёт не
 * идут, как и аккаунты без добытой пары токенов — отдавать их нечего.
 *
 * `withPoints` — подмножество: из готовых те, у кого очки ещё целы (панель или
 * леджер). Аккаунт может быть свободен, а его очки уже сожжены потребителем —
 * клетку забрали до нас (см. `isSpent`).
 */
export function issuableCounts(
  accounts: readonly IssuableAccount[],
  now: Date = new Date(),
  tokenReadyIds?: ReadonlySet<number> | number[],
): IssuableCounts {
  const ready = tokenReadyIds ? new Set(tokenReadyIds) : null;
  let count = 0;
  let withPoints = 0;
  for (const account of accounts) {
    // Очки при выборе НЕ проверяются (заказ владельца 20.11): их проверяет
    // забор `signin/claim` в момент выдачи. Структурные отсечки остаются.
    if (isUnavailable(account, now, { pointsMatter: false })) continue;
    if (ready && !ready.has(account.id)) continue;
    count += 1;
    if (!isSpent(account, now)) withPoints += 1;
  }
  return { ready: count, withPoints };
}

/** Число с неразрывными пробелами — так владелец привык читать очки. */
function num(value: number): string {
  return value.toLocaleString('ru-RU');
}

/**
 * Строки блока «Текучка».
 *
 * **Одна строка — одно утверждение** (правило блока «Пул и бонусы»): владелец
 * жаловался, что в статистике «одна строка про одно говорит, вторая ей
 * противоречит». Поэтому здесь нет строк, которые повторяют друг друга: окно
 * названо явно, каждое число — про своё.
 */
export function trafficLines(
  stats: TrafficStats,
  pool: IssuableCounts,
): PoolLine[] {
  const lines: PoolLine[] = [];

  lines.push({
    label: 'Сутки',
    value: `${stats.label} · окно 05:00 → 05:00 МСК`,
  });

  lines.push({
    label: 'Всего',
    value: `${num(stats.total)} ${plural(stats.total, 'аккаунт', 'аккаунта', 'аккаунтов')} в системе`,
  });

  const spentParts = [
    `отдали ${num(stats.handed)} на ${num(stats.handedPoints)} очков`,
    `клетку забрал потребитель — ${num(stats.consumerTaken)}`,
  ];
  if (stats.manual > 0) {
    spentParts.push(`вручную владельцем — ${num(stats.manual)}`);
  }
  lines.push({
    label: 'Потрачено сегодня',
    value:
      `${num(stats.spent)} ${plural(stats.spent, 'аккаунт', 'аккаунта', 'аккаунтов')} — ` +
      spentParts.join(' · '),
  });

  lines.push({
    label: 'Осталось',
    value:
      `${num(pool.withPoints)} с целыми очками ` +
      `(${num(pool.ready)} ${plural(pool.ready, 'готов', 'готовы', 'готовых')} к выдаче)`,
  });

  return lines;
}
