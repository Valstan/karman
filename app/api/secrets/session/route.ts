import { NextResponse } from 'next/server';
import { openSession, revokeSession } from '@/lib/services/passport';
import { rateLimit } from '@/lib/secrets/rate-limit';

// Проверка подписи и генерация токена (jose + node:crypto) требуют Node runtime.
export const runtime = 'nodejs';

/**
 * Паспортный вход в vault (ADR-0012 мозга, волна 2).
 *   POST   /api/secrets/session  → { ok, token, tokenPrefix, expiresAt, slug, canWrite }
 *   DELETE /api/secrets/session  → самоотзыв текущей сессии
 *
 * POST: `Authorization: Bearer <удостоверение CI>` (OIDC-JWT, запрошенный с
 * audience `karman-vault`). Возвращается КОРОТКОЖИВУЩИЙ skm_-токен своей комнаты —
 * дальше работает штатный контур `GET/POST /api/secrets`, менять клиента не надо.
 * DELETE: `Authorization: Bearer skm_…` (сам сессионный токен).
 *
 * Общего секрета в этом пути нет: личность берётся из подписи, а не из строки.
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

export async function POST(req: Request) {
  const ip = clientIp(req);
  // Грубый бакет по IP — только чтобы неаутентифицированный поток не доходил до
  // проверки подписи. Настоящий лимит — по доказанному claim'у, в сервисе.
  if (!rateLimit(`session|${ip ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  const assertion = bearerToken(req);
  if (!assertion) {
    return NextResponse.json({ error: 'Требуется удостоверение в Bearer' }, { status: 401 });
  }

  const result = await openSession(assertion, ip);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    {
      ok: true,
      token: result.token,
      tokenPrefix: result.tokenPrefix,
      expiresAt: result.expiresAt,
      slug: result.slug,
      canWrite: result.canWrite,
      // Клиент вправе знать, что подпись проверена по устаревшему снимку ключей.
      jwksStale: result.jwksStale,
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function DELETE(req: Request) {
  const ip = clientIp(req);
  const token = bearerToken(req);
  if (!token) {
    return NextResponse.json({ error: 'Требуется Bearer-токен' }, { status: 401 });
  }
  if (!rateLimit(`session-revoke|${token.slice(0, 16)}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  // Неизвестный и уже отозванный токен неразличимы снаружи — иначе эндпоинт
  // становится оракулом «существует ли такой токен».
  const revoked = await revokeSession(token, ip);
  if (!revoked) {
    return NextResponse.json({ error: 'Недействительный токен' }, { status: 401 });
  }
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
