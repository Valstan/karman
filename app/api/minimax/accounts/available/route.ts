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
 *   GET /api/minimax/accounts/available
 *     → { account: { id, title, email, password, activation_index, points_next,
 *                    streak, next_bonus_in_days, used_on, quota_exhausted },
 *         tier: 'points_400' | 'points_1000' | 'points_0' | null,
 *         reason: null | 'no_free_accounts',
 *         free, soon, project, today }
 *
 * Аккаунт — **один**, самый подходящий по нашим правилам (`lib/accounts/rotation.ts`),
 * но с фильтром владельца (13.11): проекту отдаётся аккаунт на **400 очков**; на
 * **1000** — только если свободных четырёхсотых не осталось (тысячные владелец
 * оставляет себе под программирование на компе); уже отмеченные сегодня (0 очков) —
 * последним резервом.
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

  const result = await issueAccount(token, ip);
  if (!result.ok) {
    return NextResponse.json({ error: result.error.error }, { status: result.error.status });
  }
  return NextResponse.json(result.offer, { headers: { 'Cache-Control': 'no-store' } });
}
