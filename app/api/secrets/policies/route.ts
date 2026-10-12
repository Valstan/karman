import { NextResponse } from 'next/server';
import {
  declarePolicyByToken,
  listPoliciesByToken,
  revokePolicyByToken,
} from '@/lib/services/secrets';
import { grantsGate, GRANTS_NO_STORE } from '@/lib/secrets/grants-gate';
import { secretPolicyDeclareSchema, secretPolicyRevokeSchema } from '@/lib/validation/secret';

// hashToken (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Политики приёма — машинный путь комнаты-получателя (S2, D-119).
 *   GET    /api/secrets/policies → свои политики (живые и отозванные)
 *   POST   /api/secrets/policies {source_slug, source_key, alias?, note?}
 *          → 201 { ok, id, autoAccept: true } — авто-приём включается сразу
 *   DELETE /api/secrets/policies { id } → { ok, id } — отзыв одной строкой,
 *          вступает сразу: будущие предложения ждут ручного accept
 * Авторизация: `Authorization: Bearer skm_…` — токен САМОЙ комнаты-получателя
 * (политика — его согласие принимать чужие ключи, класс записи; у GET
 * достаточно read-only). Гейт общий с выдачами: Bearer + rate-limit.
 * Контракт для клиентов — `docs/secrets-client-guide.md` § «Политика приёма».
 */
export async function GET(req: Request) {
  const g = grantsGate(req);
  if (g instanceof NextResponse) return g;

  const result = await listPoliciesByToken(g.token, g.ip);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ slug: result.slug, policies: result.policies }, GRANTS_NO_STORE);
}

export async function POST(req: Request) {
  const g = grantsGate(req);
  if (g instanceof NextResponse) return g;

  const body = await req.json().catch(() => null);
  const parsed = secretPolicyDeclareSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await declarePolicyByToken(g.token, g.ip, parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.id, autoAccept: true }, { status: 201, ...GRANTS_NO_STORE });
}

export async function DELETE(req: Request) {
  const g = grantsGate(req);
  if (g instanceof NextResponse) return g;

  const body = await req.json().catch(() => null);
  const parsed = secretPolicyRevokeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await revokePolicyByToken(g.token, g.ip, parsed.data.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.id }, GRANTS_NO_STORE);
}
