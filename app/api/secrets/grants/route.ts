import { NextResponse } from 'next/server';
import { listGrantsByToken, revokeGrantByToken } from '@/lib/services/secrets';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { secretGrantApiRevokeSchema } from '@/lib/validation/secret';

// hashToken (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Выдачи комнаты машинным путём (D-061, второй ход).
 *   GET    /api/secrets/grants → { slug, issued: [...] } — что комната выдала
 *   DELETE /api/secrets/grants { id } → { ok, id } — отзыв своей выдачи
 *   POST   /api/secrets/grants → 403, см. ниже
 * Авторизация: `Authorization: Bearer skm_…` — токен комнаты-ИСТОЧНИКА с правом
 * записи. Принципал в аудите — `room:<slug>`.
 *
 * ПОЧЕМУ СОЗДАНИЕ ЗАКРЫТО. Выдача пишет имя в ЧУЖОЕ пространство имён: значение
 * приезжает получателю в общий ответ `GET /api/secrets` под именем, которое
 * выбрал выдающий. Свой ключ получателя выигрывает, но НОВОЕ имя подмешивается
 * молча, а клиентский рецепт учит раскладывать полученное в переменные
 * окружения CI. То есть токен одной комнаты давал бы подстановку произвольной
 * переменной в чужую сборку — ровно та операция, которую `docs/passport-server.md`
 * («Границы v1») вырезал адверсариальной проверкой: цель выбирает вызывающий,
 * согласия цели не требуется.
 *
 * Отзыв и чтение такой цены не имеют и остаются: они действуют на выдачи своей
 * комнаты и ничего никому не подкладывают.
 *
 * Машинный путь вернётся ДВУСТОРОННИМ: источник предлагает, получатель принимает
 * своим токеном. Тогда «ключи ходят без рук владельца» (D-061) выполняется,
 * а согласие цели появляется. До тех пор выдача — операция владельца в GUI.
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

/** Общий вход: Bearer + rate-limit; null — ответ уже сформирован. */
function gate(req: Request): { token: string; ip: string | null } | NextResponse {
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

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(req: Request) {
  const g = gate(req);
  if (g instanceof NextResponse) return g;

  const result = await listGrantsByToken(g.token, g.ip);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ slug: result.slug, issued: result.issued }, NO_STORE);
}

/**
 * Создание выдачи по токену закрыто — причина в шапке файла. Отвечаем `403` с
 * объяснением, а не `405`: у пути есть работающие методы, и клиенту нужно знать
 * не «метода нет», а «эта операция сейчас за владельцем, и вот почему».
 */
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error:
        'Выдача доступа по токену закрыта: она пишет имя ключа в чужую комнату, а согласия получателя этот путь не спрашивает. Сейчас выдачу делает владелец в GUI; машинный путь вернётся двусторонним (источник предлагает, получатель принимает своим токеном).',
    },
    { status: 403, ...NO_STORE },
  );
}

export async function DELETE(req: Request) {
  const g = gate(req);
  if (g instanceof NextResponse) return g;

  const body = await req.json().catch(() => null);
  const parsed = secretGrantApiRevokeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  const result = await revokeGrantByToken(g.token, g.ip, parsed.data.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.id }, NO_STORE);
}
