import { NextResponse } from 'next/server';
import { listDerivationsByToken, listHomesByToken } from '@/lib/services/secrets/derive';
import { GRANTS_NO_STORE, grantsGate } from '@/lib/secrets/grants-gate';
import { secretDerivationsQuerySchema } from '@/lib/validation/secret';

// hashToken (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Родословная производных (D-191, ADR-0015) — две стороны одного вопроса.
 *   GET /api/secrets/derivations
 *        → { slug, derivations: [{key, origin_project_slug, origin_key, derived_at,
 *                                  orphaned, source_unavailable}] }
 *      «мои производные»: какие мои секреты — копии, откуда и жива ли их родословная.
 *   GET /api/secrets/derivations?source_key=K
 *        → { slug, source_key, homes: [{room, key, derived_at, orphaned, source_unavailable}] }
 *      «дома моего ключа» — реестр домов (#226): кто и когда завёл копии моего ключа.
 *      Отвечает владелец данных источника; ключ обязан лежать в его комнате.
 *
 * Авторизация: `Authorization: Bearer skm_…` — токен САМОЙ комнаты. Чтение, поэтому
 * read-only токен достаточно: родословная — не изменение секрета.
 */
export async function GET(req: Request) {
  const g = grantsGate(req);
  if (g instanceof NextResponse) return g;

  const url = new URL(req.url);
  const parsed = secretDerivationsQuerySchema.safeParse({
    source_key: url.searchParams.get('source_key') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректные параметры запроса' },
      { status: 400 },
    );
  }

  if (parsed.data.source_key) {
    const homes = await listHomesByToken(g.token, g.ip, parsed.data.source_key);
    if (!homes.ok) {
      return NextResponse.json({ error: homes.error }, { status: homes.status });
    }
    return NextResponse.json(
      { slug: homes.slug, source_key: homes.source_key, homes: homes.homes },
      GRANTS_NO_STORE,
    );
  }

  const result = await listDerivationsByToken(g.token, g.ip);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { slug: result.slug, derivations: result.derivations },
    GRANTS_NO_STORE,
  );
}
