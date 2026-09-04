import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authOidcIdentity, authUser } from '@/lib/db/schema';
import { isUniqueViolation } from '@/lib/db/pg-error';
import { hasUsablePassword } from '@/lib/auth/password';

/**
 * Привязка и отвязка личности ЕСА к аккаунту КАРМАНа (задача владельца 2026-09-04).
 *
 * Привязка по СЕССИИ, а не по совпадению почты: доказательством служит то, что
 * человек одновременно вошёл в КАРМАН и прошёл аутентификацию у провайдера.
 * Почта здесь не нужна вовсе — и это важно практически, а не теоретически:
 * ЕСА подтверждённую почту отдаёт не всегда, и путь «войти по совпадению почты»
 * ровно поэтому у владельца и не сработал.
 *
 * Отвязка — ПОМЕТКА `revoked_at`, а не удаление строки: строка это единственный
 * след того, что связь существовала, а у `auth_audit` нет колонки `detail`.
 * Уникальность держат ЧАСТИЧНЫЕ индексы (миграция 0016), поэтому каждое чтение
 * здесь несёт `isNull(revokedAt)` — отозванная связь пускать не вправе.
 */

export type EsaIdentity = {
  id: number;
  subject: string;
  email: string | null;
  origin: string;
  createdAt: string;
  lastLoginAt: string | null;
};

/** Живая личность пользователя у этого издателя, если она есть. */
export async function getEsaIdentity(userId: number, issuer: string): Promise<EsaIdentity | null> {
  const [row] = await db
    .select({
      id: authOidcIdentity.id,
      subject: authOidcIdentity.subject,
      email: authOidcIdentity.email,
      origin: authOidcIdentity.origin,
      createdAt: authOidcIdentity.createdAt,
      lastLoginAt: authOidcIdentity.lastLoginAt,
    })
    .from(authOidcIdentity)
    .where(
      and(
        eq(authOidcIdentity.userId, userId),
        eq(authOidcIdentity.issuer, issuer),
        isNull(authOidcIdentity.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type LinkResult =
  | { ok: true; already: boolean }
  | { ok: false; reason: 'taken' | 'already_has'; error: string };

/**
 * Привязать личность к пользователю.
 *
 * Обе гонки ловятся нарушением уникальности, а не предварительной выборкой:
 * между проверкой и вставкой успевает вставиться параллельный запрос.
 * `onConflictDoNothing` здесь неприменим — индексы частичные, Postgres на такой
 * target отвечает `42P10` (см. `lib/db/pg-error.ts`).
 */
export async function linkEsaIdentity(
  userId: number,
  issuer: string,
  subject: string,
  email: string | null,
): Promise<LinkResult> {
  try {
    await db.insert(authOidcIdentity).values({
      issuer,
      subject,
      userId,
      email,
      // Явно, а не умолчанием: в БД по умолчанию стоит рудиментное
      // 'provisioned' от снятой само-регистрации, и опираться на него нельзя.
      origin: 'linked_by_user',
      lastLoginAt: null,
    });
    return { ok: true, already: false };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;

    // Какой из двух частичных индексов сработал — выясняем по данным, а не по
    // тексту ошибки: имена индексов в сообщении менялись бы вместе с миграцией.
    const [sameSubject] = await db
      .select({ userId: authOidcIdentity.userId })
      .from(authOidcIdentity)
      .where(
        and(
          eq(authOidcIdentity.issuer, issuer),
          eq(authOidcIdentity.subject, subject),
          isNull(authOidcIdentity.revokedAt),
        ),
      )
      .limit(1);

    if (sameSubject?.userId === userId) {
      // Та же личность у того же человека — привязка уже случилась.
      return { ok: true, already: true };
    }
    if (sameSubject) {
      return {
        ok: false,
        reason: 'taken',
        error: 'Эта личность ЕСА уже привязана к другой учётной записи',
      };
    }
    return {
      ok: false,
      reason: 'already_has',
      error: 'К этой учётной записи уже привязана личность ЕСА — сначала отвяжите её',
    };
  }
}

export type UnlinkResult =
  | { ok: true; removed: boolean }
  | { ok: false; reason: 'no_password'; error: string };

/**
 * Отвязать личность.
 *
 * **Защита от запирания снаружи.** Отвязать нельзя, если у человека нет
 * рабочего пароля: ЕСА оказалась бы его единственным способом войти, и отвязка
 * закрыла бы дверь с той стороны, где он стоит. Предикат берётся общий с
 * проверкой пароля (`hasUsablePassword`), а не переписывается своими словами:
 * отказов у неё шире, чем «пусто или с восклицательным знаком», а хэши в
 * `auth_user` достались от старой системы и нами не контролировались.
 */
export async function unlinkEsaIdentity(
  userId: number,
  issuer: string,
  now: string = new Date().toISOString(),
): Promise<UnlinkResult> {
  const [user] = await db
    .select({ password: authUser.password })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);

  if (!hasUsablePassword(user?.password ?? null)) {
    return {
      ok: false,
      reason: 'no_password',
      error:
        'Вход через ЕСА — ваш единственный способ войти. Сначала задайте пароль, иначе отвязка закроет вам доступ',
    };
  }

  // `isNull(revokedAt)` в WHERE делает повторную отвязку безвредной и не даёт
  // затереть отметку времени у уже отозванной связи.
  const rows = await db
    .update(authOidcIdentity)
    .set({ revokedAt: now })
    .where(
      and(
        eq(authOidcIdentity.userId, userId),
        eq(authOidcIdentity.issuer, issuer),
        isNull(authOidcIdentity.revokedAt),
      ),
    )
    .returning({ id: authOidcIdentity.id });

  return { ok: true, removed: rows.length > 0 };
}
