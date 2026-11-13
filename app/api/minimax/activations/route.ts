import { NextResponse } from 'next/server';
import { bearerToken } from '@/lib/api/request';
import { clientIp } from '@/lib/api/client-ip';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { minimaxActivationSchema } from '@/lib/validation/account';
import { recordActivation } from '@/lib/services/minimax';

// Запись в журнал активаций идёт через node:crypto (AAD пароля) — Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * «Активация сделана» — запись факта от проекта (машинный доступ к пулу, 13.11).
 *
 *   POST /api/minimax/activations
 *     { account_id, points?, activation_index? }
 *     → { account_id, used_on, activation_index, points, points_expected,
 *         mismatch, source, updated, project }
 *
 * Идемпотентность по `(account_id, день)`: повтор от ТОГО ЖЕ проекта обновляет строку
 * дня. Повтор от ДРУГОГО проекта — **409**: аккаунт уже отработан сегодня, бери
 * другой (правило одной правды: «аккаунт, активированный в одном проекте, не должен
 * предлагаться в те же сутки другому»). Аккаунт в окне 5 часов — тоже 409.
 *
 * `activation_index` — клетка, которую проект увидел на панели MiniMax. Она ложится в
 * журнал как истина (тем же полем, что и номер владельца), но расхождение с нашим
 * предсказанием только помечается (`mismatch`): правило клетки не меняется по одному
 * чужому показанию.
 *
 * Авторизация: `Authorization: Bearer skm_…` — токен комнаты с правом записи.
 */
export async function POST(req: Request) {
  const token = bearerToken(req);
  if (!token) {
    return NextResponse.json({ error: 'Требуется Bearer-токен' }, { status: 401 });
  }
  const ip = clientIp(req);
  if (!rateLimit(`minimax-activations|${token.slice(0, 16)}|${ip ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const parsed = minimaxActivationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await recordActivation(token, ip, {
    accountId: parsed.data.account_id,
    points: parsed.data.points ?? null,
    activationIndex: parsed.data.activation_index ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error.error }, { status: result.error.status });
  }
  return NextResponse.json(result.record, { headers: { 'Cache-Control': 'no-store' } });
}
