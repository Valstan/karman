import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authOidcIdentity, authUser } from '@/lib/db/schema';
import { hashDjangoPassword } from '@/lib/auth/password';
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
 *  3. **Иначе — заводим нового пользователя без прав** (решение владельца
 *     2026-08-25: «любой ЕСА-аккаунт заводит пользователя»). `is_superuser`
 *     остаётся false, а весь доступ к данным фильтруется по владельцу
 *     (`lib/auth/rbac.ts`), поэтому новый человек не видит ни чужих кредитов,
 *     ни чужих комнат vault. Пароль ставится заведомо непроверяемый: войти
 *     этой учёткой можно только через ЕСА.
 */

export type ResolvedLogin = {
  userId: number;
  username: string;
  /** Как разрешилась личность — уходит в аудит, чтобы отличать заведённых снаружи. */
  outcome: 'existing_identity' | 'linked_by_email' | 'provisioned';
};

export type ResolveFailure = { ok: false; reason: 'user_inactive' | 'ambiguous_email' };
export type ResolveResult = { ok: true; login: ResolvedLogin } | ResolveFailure;

/**
 * Пароль, который не пройдёт проверку никогда. Django для этого пишет `!`
 * с мусором; наш `verifyDjangoPassword` на такой строке вернёт false, потому
 * что она не разбирается как `algo$iterations$salt$hash`. Пустую строку сюда
 * класть нельзя: колонка `NOT NULL`, а пустое значение слишком легко принять
 * за «пароль не задан, пустите так».
 */
function unusablePassword(): string {
  return `!oidc-only-${Date.now().toString(36)}`;
}

/** Логин из почты/имени, приведённый к тому, что допускает колонка `username`. */
function candidateUsername(claims: OidcClaims): string {
  const base =
    claims.email?.split('@')[0] ??
    claims.name ??
    `esa-${claims.subject.slice(0, 12)}`;
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 100);
  return cleaned.length >= 2 ? cleaned : `esa-${claims.subject.slice(0, 12)}`;
}

/** Свободное имя: к занятому дописывается суффикс, а не падает вставка. */
async function freeUsername(base: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    const [taken] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(sql`lower(${authUser.username}) = lower(${candidate})`)
      .limit(1);
    if (!taken) return candidate;
  }
  // 50 занятых подряд — что-то не так; уникальность гарантируем временем.
  return `${base}-${Date.now().toString(36)}`;
}

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

  // --- 3. Новый пользователь без прав ----------------------------------------
  const username = await freeUsername(candidateUsername(claims));
  const [inserted] = await db
    .insert(authUser)
    .values({
      username,
      email: claims.email ?? '',
      password: hashDjangoPassword(unusablePassword()),
      firstName: claims.name?.split(' ')[0]?.slice(0, 150) ?? '',
      lastName: claims.name?.split(' ').slice(1).join(' ').slice(0, 150) ?? '',
      isActive: true,
      isSuperuser: false,
      isStaff: false,
    })
    .returning({ id: authUser.id, username: authUser.username });
  if (!inserted) throw new Error('не удалось завести пользователя для личности ЕСА');

  await db.insert(authOidcIdentity).values({
    issuer,
    subject: claims.subject,
    userId: inserted.id,
    email: claims.email,
    origin: 'provisioned',
    lastLoginAt: now,
  });

  return {
    ok: true,
    login: { userId: inserted.id, username: inserted.username, outcome: 'provisioned' },
  };
}
