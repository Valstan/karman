import { NextResponse } from 'next/server';
import { deriveSecretByToken } from '@/lib/services/secrets/derive';
import { GRANTS_NO_STORE, grantsGate } from '@/lib/secrets/grants-gate';
import { secretDeriveSchema } from '@/lib/validation/secret';

// hashToken (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Производная — копия чужого секрета себе, с родословной (D-191, ADR-0015).
 *   POST /api/secrets/derive {source_key, source_slug?, target_key, note?}
 *        → 201 { ok, target_key, origin: { project, key }, derived_at }
 * Авторизация: `Authorization: Bearer skm_…` — токен комнаты-ПОЛУЧАТЕЛЯ **с правом
 * записи**: производная создаёт запись в комнате, RO-токен не может (мандат brain
 * 12.11: «производную создаёт только пишущий токен — это расширение права записи»).
 *
 * Что проверяется:
 *   - источник виден получателю по ДЕЙСТВУЮЩЕЙ выдаче (ADR-0015 п.5): без неё 403 —
 *     копия не выдаёт права на источник, и «вывести что угодно по имени» невозможно;
 *   - `target_key` не занимает имя выданной выдачи и не затирает свой секрет (409);
 *   - в родословной лежит ОРИГИНАЛ (комната и ключ источника), а не то имя, под
 *     которым источник увидел получатель.
 *
 * Копия — обычный секрет своей комнаты: читается обычным `GET /api/secrets`, правами
 * источника НЕ наследует, и её гибель/правка не трогает оригинал.
 */
export async function POST(req: Request) {
  const g = grantsGate(req);
  if (g instanceof NextResponse) return g;

  const body = await req.json().catch(() => null);
  const parsed = secretDeriveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await deriveSecretByToken(g.token, g.ip, parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    {
      ok: true,
      target_key: result.derived.key,
      origin: {
        project: result.derived.origin_project_slug,
        key: result.derived.origin_key,
      },
      derived_at: result.derived.derived_at,
    },
    { status: 201, ...GRANTS_NO_STORE },
  );
}
