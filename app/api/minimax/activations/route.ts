import { NextResponse } from 'next/server';
import { bearerToken } from '@/lib/api/request';
import { clientIp } from '@/lib/api/client-ip';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { minimaxObservationSchema } from '@/lib/validation/account';
import { recordObservation } from '@/lib/services/minimax';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * **Наблюдение потребителя: сколько очков было на выданном токене.**
 *
 *   POST /api/minimax/activations
 *     { account_id | email, points?, activation_index? }
 *     → { account_id, used_on, activation_index, points, points_expected,
 *         cell_expected, cell_mismatch, points_mismatch, mismatch, source, project }
 *
 * Заказ владельца (14.11, 01:10 МСК): «принимай от панели программирования и от сарафана
 * ответки о том сколько они очков на токене только что полученном активировали чекнули,
 * ну чтобы ты подтверждал свою статистику предсказание по очкам или подкорректировал ее
 * если у тебя неправильно предсказано было по токену».
 *
 * Что это НЕ: потребитель не пишет в наш учёт. Активацию, окно простоя, проект и метку
 * ведём мы при выдаче (см. `GET /api/minimax/accounts/available`). Сюда приходит только
 * **факт**, который потребитель видел на панели MiniMax: сколько очков было на токене (и,
 * если знает, номер клетки). Факт ложится в журнал как истина, а расхождение с нашим
 * предсказанием возвращается флагом — это второй, независимый источник по вопросу о
 * клетке после пропущенного дня (аккаунт 3@).
 *
 * Цепочка токенов неприкосновенна: refresh не принимается (и не отдаётся).
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
  const parsed = minimaxObservationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await recordObservation(token, ip, {
    accountId: parsed.data.account_id ?? null,
    email: parsed.data.email ?? null,
    points: parsed.data.points ?? null,
    activationIndex: parsed.data.activation_index ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error.error }, { status: result.error.status });
  }
  return NextResponse.json(result.record, { headers: { 'Cache-Control': 'no-store' } });
}
