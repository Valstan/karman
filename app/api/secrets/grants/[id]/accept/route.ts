import { NextResponse } from 'next/server';
import { acceptGrantByToken } from '@/lib/services/secrets';
import { GRANTS_NO_STORE, grantsGate } from '@/lib/secrets/grants-gate';

// hashToken (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Согласие получателя — вторая рука двустороннего grant'а (D-061).
 *   POST /api/secrets/grants/<id>/accept → { ok, id, state: "active" }
 * Авторизация: токен комнаты-ПОЛУЧАТЕЛЯ с правом записи: принять чужое имя в
 * своё окружение — операция класса записи. До этого запроса значение по выдаче
 * не отдаётся и имя у получателя не занято.
 * Коды: 403 — токен только для чтения; 404 — предложение не этой комнате;
 * 409 — уже принято, отозвано, имя занято своим ключом или другой выдачей.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = grantsGate(req);
  if (g instanceof NextResponse) return g;

  const { id } = await ctx.params;
  const grantId = Number(id);
  if (!Number.isInteger(grantId) || grantId <= 0) {
    return NextResponse.json({ error: 'Некорректный id выдачи' }, { status: 400 });
  }

  const result = await acceptGrantByToken(g.token, g.ip, grantId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.id, state: 'active' }, GRANTS_NO_STORE);
}
