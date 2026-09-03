import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authOidcIdentity, authUser } from '@/lib/db/schema';
import type { OidcClaims } from '@/lib/auth/oidc';

/**
 * Разрешение личности ЕСА в пользователя КАРМАНа.
 *
 * Три исхода, и порядок между ними принципиален:
 *
 *  1. **Личность уже привязана** (issuer + sub) — берём её пользователя.
 *     Привязка по `sub`, а не по почте: `sub` у провайдера неизменяемый,
 *     а почта у человека меняется. Связь по почте означала бы, что смена
 *     почты меняет владельца аккаунта.
 *
 *  2. **Совпала ПОДТВЕРЖДЁННАЯ почта существующего пользователя** — привязываем
 *     к нему. Это единственный способ для владельца войти в СВОЙ аккаунт через
 *     ЕСА, не заводя вторую учётку: заранее связать личность неоткуда, пока GUI
 *     привязки нет. Риск класса «захват аккаунта по почте» закрыт не здесь,
 *     а вторым фактором: у пользователя с включённым TOTP вход всё равно
 *     упирается в код из приложения, которого у чужого владельца почты нет.
 *     Поэтому `email_verified` обязателен, и совпадение обязано быть РОВНО
 *     одно — иначе непонятно, к кому привязывать, и мы отказываемся угадывать.
 *
 *  3. **Иначе — отказ.** До 2026-09-03 здесь заводился новый пользователь:
 *     решение владельца 2026-08-25 звучало как «любой ЕСА-аккаунт заводит
 *     пользователя КАРМАНа». Оно отменено вместе с приходом персональных
 *     данных: теперь аккаунт заводит владелец приглашением
 *     (`lib/services/users.ts` → `createAccount`), а ЕСА остаётся способом
 *     ВОЙТИ, а не способом ЗАРЕГИСТРИРОВАТЬСЯ.
 *
 *     Причина смены решения конкретная, а не вкусовая: с ЕСА-регистрацией
 *     список пользователей КАРМАНа определялся списком пользователей чужой
 *     системы. Пока в базе лежали только кредиты владельца, это ничего не
 *     стоило; с паспортами и СНИЛСами родственников — круг людей, у которых
 *     есть учётка рядом с этими данными, обязан быть решением владельца.
 */

export type ResolvedLogin = {
  userId: number;
  username: string;
  /** Как разрешилась личность — уходит в аудит, чтобы отличать заведённых снаружи. */
  outcome: 'existing_identity' | 'linked_by_email';
};

export type ResolveFailure = {
  ok: false;
  reason: 'user_inactive' | 'ambiguous_email' | 'not_invited';
};
export type ResolveResult = { ok: true; login: ResolvedLogin } | ResolveFailure;

export async function resolveOidcLogin(
  issuer: string,
  claims: OidcClaims,
  // ISO-строка, а не Date: колонки времени в схеме объявлены с mode:'string'.
  now: string = new Date().toISOString(),
): Promise<ResolveResult> {
  // --- 1. Уже привязанная личность -------------------------------------------
  const [existing] = await db
    .select({
      identityId: authOidcIdentity.id,
      userId: authUser.id,
      username: authUser.username,
      isActive: authUser.isActive,
    })
    .from(authOidcIdentity)
    .innerJoin(authUser, eq(authUser.id, authOidcIdentity.userId))
    .where(
      and(eq(authOidcIdentity.issuer, issuer), eq(authOidcIdentity.subject, claims.subject)),
    )
    .limit(1);

  if (existing) {
    // Деактивированный пользователь не пускается, даже если личность привязана:
    // отключение учётки обязано гасить ВСЕ пути входа, иначе оно декоративное.
    if (!existing.isActive) return { ok: false, reason: 'user_inactive' };
    await db
      .update(authOidcIdentity)
      .set({ lastLoginAt: now, email: claims.email })
      .where(eq(authOidcIdentity.id, existing.identityId));
    return {
      ok: true,
      login: { userId: existing.userId, username: existing.username, outcome: 'existing_identity' },
    };
  }

  // --- 2. Подтверждённая почта существующего пользователя ---------------------
  if (claims.emailVerified && claims.email) {
    const matches = await db
      .select({ id: authUser.id, username: authUser.username, isActive: authUser.isActive })
      .from(authUser)
      .where(sql`lower(${authUser.email}) = lower(${claims.email})`)
      .limit(2);

    const active = matches.filter((m) => m.isActive);
    if (active.length > 1) {
      // Двое живых с одной почтой — привязка была бы угадыванием.
      return { ok: false, reason: 'ambiguous_email' };
    }
    const user = active[0];
    if (user) {
      await db.insert(authOidcIdentity).values({
        issuer,
        subject: claims.subject,
        userId: user.id,
        email: claims.email,
        origin: 'linked_by_email',
        lastLoginAt: now,
      });
      return {
        ok: true,
        login: { userId: user.id, username: user.username, outcome: 'linked_by_email' },
      };
    }
  }

  // --- 3. Незнакомая личность — отказ, аккаунт не заводим ---------------------
  // Ничего не пишем в БД: ни пользователя, ни строку личности. Запись «личность
  // приходила, но её развернули» жила бы вечно и без хозяина — а факт попытки
  // и так фиксируется в auth_audit вызывающим роутом (esa_resolve_fail:*).
  return { ok: false, reason: 'not_invited' };
}
