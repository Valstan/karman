import { NextResponse } from 'next/server';
import { claimBootstrap } from '@/lib/services/bootstrap';
import { rateLimit } from '@/lib/secrets/rate-limit';

// hashBootstrapCode + генерация токена (node:crypto) требуют Node runtime.
export const runtime = 'nodejs';

/**
 * Обмен времянки на токен своей комнаты (задача владельца 2026-08-10).
 *   POST /api/secrets/claim   `Authorization: Bearer skb_…`
 *   → 201 { ok, token, tokenPrefix, slug, canWrite }
 *
 * Времянку выпускает владелец в `/secrets`; она живёт минуты, гасится в момент
 * обмена и привязана к одной комнате — поэтому её можно продиктовать вслух или
 * прислать в чат. Долгоживущий токен при этом не звучит нигде: он приходит
 * ответом на этот запрос и сразу кладётся проектом в свой рантайм-env.
 *
 * Все отказы — один 401 без деталей: неизвестный код, истёкший, отозванный и уже
 * обменянный снаружи неразличимы, иначе эндпоинт становится оракулом. Причина —
 * в аудите комнаты.
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
  if (!rateLimit(`claim|${ip ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  const code = bearerToken(req);
  if (!code) {
    return NextResponse.json({ error: 'Требуется код в Bearer' }, { status: 401 });
  }

  const result = await claimBootstrap(code, ip);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    {
      ok: true,
      token: result.token,
      tokenPrefix: result.tokenPrefix,
      slug: result.slug,
      projectId: result.projectId,
      canWrite: result.canWrite,
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
