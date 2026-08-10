import { NextResponse } from 'next/server';
import { describeSession } from '@/lib/services/passport';
import { rateLimit } from '@/lib/secrets/rate-limit';

// hashToken (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Интроспекция собственного токена (ADR-0012 волна 2).
 *   GET /api/secrets/self → { slug, canWrite, identity, expiresAt, createdAt, lastUsedAt }
 * Авторизация: `Authorization: Bearer skm_…` (свой токен — чужой не покажет).
 *
 * Зачем: клиент CI должен уметь ответить «кто я и до когда» без обращения к
 * владельцу. Отзыв/истечение читаются как 401 — то же, что увидит `/api/secrets`.
 */
function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim());
  const token = m?.[1]?.trim();
  return token ? token : null;
}

export async function GET(req: Request) {
  const token = bearerToken(req);
  if (!token) {
    return NextResponse.json({ error: 'Требуется Bearer-токен' }, { status: 401 });
  }
  if (!rateLimit(`self|${token.slice(0, 16)}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  const info = await describeSession(token);
  if (!info) {
    return NextResponse.json({ error: 'Недействительный токен' }, { status: 401 });
  }
  return NextResponse.json(
    {
      slug: info.slug,
      projectId: info.projectId,
      canWrite: info.canWrite,
      // null — статический токен комнаты, выданный владельцем (не паспортная сессия).
      identity: info.identityLabel,
      expiresAt: info.expiresAt,
      createdAt: info.createdAt,
      lastUsedAt: info.lastUsedAt,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
