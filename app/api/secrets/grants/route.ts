import { NextResponse } from 'next/server';
import { createGrantByToken, listGrantsByToken, revokeGrantByToken } from '@/lib/services/secrets';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { secretGrantApiCreateSchema, secretGrantApiRevokeSchema } from '@/lib/validation/secret';

// hashToken (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Выдача доступа к своему ключу другой комнате — машинным путём (D-061, второй ход).
 *   GET    /api/secrets/grants → { slug, issued: [...] } — что комната выдала
 *   POST   /api/secrets/grants { key, target_slug, alias?, note } → 201 { ok, id, ... }
 *   DELETE /api/secrets/grants { id } → { ok, id }
 * Авторизация: `Authorization: Bearer skm_…` — токен комнаты-ИСТОЧНИКА с правом записи.
 * Область — только секреты этой комнаты: комната-получатель выдать себе ничего не может,
 * полномочие остаётся у владельца данных. Принципал в аудите — `room:<slug>`.
 */
function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim());
  const token = m?.[1]?.trim();
  return token ? token : null;
}

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() ?? null;
  return req.headers.get('x-real-ip');
}

/** Общий вход: Bearer + rate-limit; null — ответ уже сформирован. */
function gate(req: Request): { token: string; ip: string | null } | NextResponse {
  const token = bearerToken(req);
  if (!token) {
    return NextResponse.json({ error: 'Требуется Bearer-токен' }, { status: 401 });
  }
  const ip = clientIp(req);
  if (!rateLimit(`grants|${token.slice(0, 16)}|${ip ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }
  return { token, ip };
}

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(req: Request) {
  const g = gate(req);
  if (g instanceof NextResponse) return g;

  const result = await listGrantsByToken(g.token, g.ip);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ slug: result.slug, issued: result.issued }, NO_STORE);
}

export async function POST(req: Request) {
  const g = gate(req);
  if (g instanceof NextResponse) return g;

  const body = await req.json().catch(() => null);
  const parsed = secretGrantApiCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await createGrantByToken(g.token, g.ip, parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    {
      ok: true,
      id: result.id,
      source: result.sourceSlug,
      target: result.targetSlug,
      key: parsed.data.key,
      alias: result.aliasKey,
    },
    { status: 201, ...NO_STORE },
  );
}

export async function DELETE(req: Request) {
  const g = gate(req);
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
  return NextResponse.json({ ok: true, id: result.id }, NO_STORE);
}
