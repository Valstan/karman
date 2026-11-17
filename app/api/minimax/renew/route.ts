import { NextResponse } from 'next/server';
import { bearerToken } from '@/lib/api/request';
import { clientIp } from '@/lib/api/client-ip';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { minimaxRenewSchema } from '@/lib/validation/account';
import { renewAccountAccess } from '@/lib/services/minimax';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * **Продление цепочки токенов аккаунта** (D-219, мандат владельца 17.11).
 *
 *   POST /api/minimax/renew
 *     { account_id }
 *     → { account_id, email, access_token, expires_at_ms, renewed }
 *
 * Зачем: access живёт 12 часов (вендорские `expires_in = 43 200`), а новый вход —
 * это две минуты ручной работы владельца в браузере. Мозг просит: **продлеваем
 * цепочку у себя и отдаём свежий access того же аккаунта**, а пара (access +
 * refresh) наружу не уходит — граница D-219 цела.
 *
 * **Аккаунт — только по `account_id`** (уточнение владельца 17.11): почта это способ
 * АВТОРИЗАЦИИ на сайте MiniMax (вход владельца по коду с почты), а не способ опознать
 * аккаунт. `account_id` потребитель знает — мы отдаём его в ответе выдачи
 * (`GET /api/minimax/accounts/available` → `account.id`).
 *
 * Что ручка НЕ делает:
 *
 * - **не отдаёт refresh** — цепочка одноразовых refresh'ей наша; наружу уходит
 *   только access (мандат владельца 14.11);
 * - **не трогает активацию** — клетка и номинал в докладе активации не меняются:
 *   продление это про токен, а не про учёт;
 * - **не выдаёт чужой аккаунт** — продлить может только та комната, которой мы этот
 *   аккаунт выдали (один аккаунт — один потребитель, G627), иначе «продление»
 *   стало бы вторым путём раздать чужой аккаунт.
 *
 * Честные отказы: 409 — аккаунт за другой комнатой или цепочка оборвана (нужен
 * новый вход владельца); 404 — аккаунта нет в пуле; 403 — токен только для чтения;
 * 400 — в теле нет `account_id`.
 *
 * Авторизация: `Authorization: Bearer skm_…` — токен комнаты **с правом записи**
 * (продление выдаёт учётные данные и пишет в аудит — операция класса записи).
 */
export async function POST(req: Request) {
  const token = bearerToken(req);
  if (!token) {
    return NextResponse.json({ error: 'Требуется Bearer-токен' }, { status: 401 });
  }
  const ip = clientIp(req);
  if (!rateLimit(`minimax-renew|${token.slice(0, 16)}|${ip ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const parsed = minimaxRenewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await renewAccountAccess(token, ip, {
    accountId: parsed.data.account_id ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error.error }, { status: result.error.status });
  }
  return NextResponse.json(result.renewal, { headers: { 'Cache-Control': 'no-store' } });
}
