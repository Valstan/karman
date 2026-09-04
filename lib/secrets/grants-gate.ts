import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/secrets/rate-limit';

/**
 * Общий вход маршрутов выдач (`/api/secrets/grants` и `…/grants/[id]/accept`):
 * Bearer-токен комнаты + rate-limit по префиксу токена и IP. Вынесен из route.ts,
 * потому что Next запрещает в файле маршрута экспорты помимо HTTP-методов.
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

export const GRANTS_NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/** NextResponse — отказ уже сформирован; иначе токен и IP для сервиса. */
export function grantsGate(req: Request): { token: string; ip: string | null } | NextResponse {
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
