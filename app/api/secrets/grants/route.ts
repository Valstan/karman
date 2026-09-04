import { NextResponse } from 'next/server';
import { listGrantsByToken, proposeGrantByToken, revokeGrantByToken } from '@/lib/services/secrets';
import { GRANTS_NO_STORE, grantsGate } from '@/lib/secrets/grants-gate';
import { secretGrantApiRevokeSchema, secretGrantProposeSchema } from '@/lib/validation/secret';

// hashToken (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Выдачи комнаты машинным путём — ДВУСТОРОННИЕ (D-061, мандат brain 2026-09-03).
 *   POST   /api/secrets/grants {key, target_slug, alias?, note}
 *          → 201 { ok, id, state: "pending" } — токен ИСТОЧНИКА предлагает выдачу
 *   POST   /api/secrets/grants/<id>/accept → токен ПОЛУЧАТЕЛЯ принимает (см. [id]/accept)
 *   GET    /api/secrets/grants[?pending=1] → { slug, issued, received } — обе стороны
 *          видят свои; `pending=1` — только входящие предложения (для CI получателя)
 *   DELETE /api/secrets/grants { id } → { ok, id } — отзыв с любой стороны
 * Авторизация: `Authorization: Bearer skm_…` — токен комнаты с правом ЗАПИСИ.
 * Принципал в аудите — `room:<slug>`.
 *
 * Почему в две руки. Односторонняя выдача токеном источника (2026-09-03, два
 * часа в проде) писала имя ключа в ЧУЖОЕ пространство имён: значение приезжало
 * получателю в общий ответ `GET /api/secrets`, а клиентский рецепт раскладывает
 * полученное в переменные окружения CI. Токен одной комнаты подставлял
 * произвольную переменную в чужую сборку — операция, вырезанная «Границами v1»
 * в `docs/passport-server.md`. Предложение до принятия в `GET /api/secrets`
 * получателя не попадает и имя у него не занимает; принять — операция класса
 * записи, поэтому у получателя тоже нужен пишущий токен.
 */
export async function GET(req: Request) {
  const g = grantsGate(req);
  if (g instanceof NextResponse) return g;

  const pending = new URL(req.url).searchParams.get('pending');
  const pendingOnly = pending === '1' || pending === 'true';
  const result = await listGrantsByToken(g.token, g.ip, pendingOnly);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { slug: result.slug, issued: result.issued, received: result.received },
    GRANTS_NO_STORE,
  );
}

export async function POST(req: Request) {
  const g = grantsGate(req);
  if (g instanceof NextResponse) return g;

  const body = await req.json().catch(() => null);
  const parsed = secretGrantProposeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await proposeGrantByToken(g.token, g.ip, parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.id, state: 'pending' }, { status: 201, ...GRANTS_NO_STORE });
}

export async function DELETE(req: Request) {
  const g = grantsGate(req);
  if (g instanceof NextResponse) return g;

  const body = await req.json().catch(() => null);
  const parsed = secretGrantApiRevokeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await revokeGrantByToken(g.token, g.ip, parsed.data.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.id }, GRANTS_NO_STORE);
}
