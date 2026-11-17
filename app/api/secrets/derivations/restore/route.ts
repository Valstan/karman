import { NextResponse } from 'next/server';
import { restoreDerivationByToken } from '@/lib/services/secrets/derive';
import { GRANTS_NO_STORE, grantsGate } from '@/lib/secrets/grants-gate';
import { secretDeriveRestoreSchema } from '@/lib/validation/secret';

// hashToken (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Снять пометку «источник умер» с производной (D-191; мандат brain 08.11: «Отмена:
 * снять пометку, если копия ещё жива и нужна»).
 *   POST /api/secrets/derivations/restore {key}
 *        → 200 { ok, key, source_alive }
 * Авторизация: `Authorization: Bearer skm_…` — токен комнаты, которой принадлежит
 * КОПИЯ, и обязательно с правом записи: снятие пометки меняет состояние записи.
 * Комната-источник снять пометку не может — это не её секрет.
 *
 * `source_alive` — жив ли источник сейчас (ключ могли переименовать и вернуть):
 * снимать пометку имеет смысл, когда источник снова есть.
 */
export async function POST(req: Request) {
  const g = grantsGate(req);
  if (g instanceof NextResponse) return g;

  const body = await req.json().catch(() => null);
  const parsed = secretDeriveRestoreSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await restoreDerivationByToken(g.token, g.ip, parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { ok: true, key: result.key, source_alive: result.source_alive },
    GRANTS_NO_STORE,
  );
}
