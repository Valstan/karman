import { NextResponse } from 'next/server';
import { pullByToken, pushByToken } from '@/lib/services/secrets';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { secretPushSchema } from '@/lib/validation/secret';

// Шифрование/расшифровка (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Машинный доступ проектов к секретам.
 *   GET  /api/secrets            → { secrets: { KEY: value, ... } }
 *   GET  /api/secrets?key=FOO    → { secrets: { FOO: value } } (или 404)
 *   POST /api/secrets            → запись (upsert), тело { secrets: { KEY: value } };
 *                                  требует токен с правом записи (can_write).
 * Авторизация: `Authorization: Bearer skm_…` (токен проекта).
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

export async function GET(req: Request) {
  const token = bearerToken(req);
  if (!token) {
    return NextResponse.json({ error: 'Требуется Bearer-токен' }, { status: 401 });
  }

  const ip = clientIp(req);
  if (!rateLimit(`${token.slice(0, 16)}|${ip ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  const key = new URL(req.url).searchParams.get('key') ?? undefined;
  const result = await pullByToken(token, ip, key);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ secrets: result.secrets }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  const token = bearerToken(req);
  if (!token) {
    return NextResponse.json({ error: 'Требуется Bearer-токен' }, { status: 401 });
  }

  const ip = clientIp(req);
  if (!rateLimit(`${token.slice(0, 16)}|${ip ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const parsed = secretPushSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await pushByToken(token, ip, parsed.data.secrets);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, written: result.written }, { headers: { 'Cache-Control': 'no-store' } });
}
