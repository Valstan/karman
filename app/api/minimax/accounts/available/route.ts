import { NextResponse } from 'next/server';
import { bearerToken } from '@/lib/api/request';
import { clientIp } from '@/lib/api/client-ip';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { issueAccount } from '@/lib/services/minimax';

// Расшифровка пароля аккаунта (node:crypto) требует Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * «Дай аккаунт MiniMax» — машинный доступ к пулу (заказ владельца 13.11).
 *
 *   GET /api/minimax/accounts/available[?exclude=67,68][&emails=a@b.c,d@e.f]
 *     → { account: { id, title, email, activation_index, points_next, streak,
 *                    next_bonus_in_days, used_on, quota_exhausted, unverified,
 *                    hint_source },
 *         tier: 'points_400' | 'points_1000' | 'points_0' | 'unverified' | null,
 *         reason: null | 'no_free_accounts',
 *         recommended: true, why: "…",
 *         free, soon, project, today }
 *
 * Аккаунт — **один**, самый подходящий по нашим правилам (`lib/accounts/rotation.ts`),
 * но с фильтром владельца (13.11): проекту отдаётся аккаунт на **400 очков**; на
 * **1000** — только если свободных четырёхсотых не осталось (тысячные владелец
 * оставляет себе под программирование на компе); уже отмеченные сегодня (0 очков) —
 * последним резервом; аккаунт под вопросом по правилу клетки — в самом конце, и его
 * подсказка по очкам НЕ отдаётся (`points_next: null`, `unverified: true`).
 *
 * **Пароля в ответе нет:** Сарафан работает по почте, программного логина по паролю у
 * MiniMax нет (13.11) — выносить секрет из vault без нужды нельзя.
 *
 * **Фильтры запроса** (просили на линии 13.11 — «нужен способ его пропустить»):
 * `exclude` — id аккаунтов, которые проекту не подходят; `emails` — почты, которые у
 * проекта есть (отдаём только такие аккаунты).
 *
 * Честная пустота: сегодня брать нечего → 200 с `account: null` и `reason`, а не 404
 * и не 500 — «аккаунтов нет» и «сервис сломался» должны различаться на стороне
 * проекта.
 *
 * Авторизация: `Authorization: Bearer skm_…` — токен комнаты **с правом записи**
 * (выдача учётных данных и запись в журнал — операции класса записи; read-only → 403).
 * Каждая выдача попадает в аудит комнаты. Ответ не кэшируется.
 */
export async function GET(req: Request) {
  const token = bearerToken(req);
  if (!token) {
    return NextResponse.json({ error: 'Требуется Bearer-токен' }, { status: 401 });
  }
  const ip = clientIp(req);
  if (!rateLimit(`minimax-available|${token.slice(0, 16)}|${ip ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  const params = new URL(req.url).searchParams;
  const result = await issueAccount(token, ip, {
    excludeIds: parseIdList(params.get('exclude')),
    emails: parseList(params.get('emails')),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error.error }, { status: result.error.status });
  }
  return NextResponse.json(result.offer, { headers: { 'Cache-Control': 'no-store' } });
}

/** Список id из строки «67,68» — только целые положительные, мусор молча пропускаем. */
function parseIdList(raw: string | null): number[] | undefined {
  if (!raw) return undefined;
  const ids = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return ids.length ? ids : undefined;
}

/** Список почт из строки «a@b.c,d@e.f». */
function parseList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}
