import { NextResponse } from 'next/server';
import { logProvisionAuthDenied, provisionRoom } from '@/lib/services/secrets';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { checkProvisionKey, provisionKeyConfigured } from '@/lib/secrets/provision-key';
import { secretProvisionSchema } from '@/lib/validation/secret';

// node:crypto (timingSafeEqual, генерация токена) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Self-serve onboarding комнаты (мандат brain 2026-07-12, амендмент §6 ADR-0006).
 *   POST /api/secrets/provision  → { ok, projectId, slug, token, tokenPrefix }
 * Тело: { slug, name? }. Авторизация: `Authorization: Bearer <VAULT_PROVISION_KEY>`
 * (provisioning-секрет #008-класса, НЕ skm_-токен и не мастер-MFA владельца).
 * Токен возвращается ОДИН раз; существующая комната → 409 (изоляция: этим путём
 * нельзя выпустить токен к уже заведённой комнате).
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
  if (!rateLimit(`provision|${ip ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  if (!provisionKeyConfigured()) {
    return NextResponse.json({ error: 'Provisioning не сконфигурирован' }, { status: 503 });
  }

  const key = bearerToken(req);
  if (!key || !checkProvisionKey(key)) {
    await logProvisionAuthDenied(ip);
    return NextResponse.json({ error: 'Недействительный provisioning-ключ' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = secretProvisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await provisionRoom(parsed.data.slug, parsed.data.name, ip);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    {
      ok: true,
      projectId: result.projectId,
      slug: result.slug,
      token: result.token,
      tokenPrefix: result.tokenPrefix,
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
