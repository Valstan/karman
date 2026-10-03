import 'server-only';
import { getCurrentUser } from '@/lib/auth/current-user';
import { readSessionPayload } from '@/lib/auth/session';
import { totpEnabled } from '@/lib/services/twofactor';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * Step-up для операций, меняющих безопасность учётки (аудит #057 R3/R4).
 *
 * ## Что закрываем
 *
 * 1. `resetAccountPassword` гейтился только суперпользователем и **возвращал временный пароль
 *    открытым текстом**. Сессия суперпользователя — bearer: украденная cookie (даже без `mfa`)
 *    давала захват любой учётки системы, а сброс пароля у чужого человека — шаг, который
 *    человек не делал.
 * 2. Управление 2FA (`startTotpEnrollment` / `confirm` / `disable`) гейтилось одной сессией.
 *    Сессия учётки **без включённой 2FA** позволяла подвесить свой TOTP: сервис отдаёт секрет
 *    и recovery-коды открытым текском, 2FA включается, а владельца вышибает из `/secrets`
 *    (у него сессии `mfa:false`, а гейт требует `mfa` при включённом 2FA). Восстановления в
 *    приложении нет — `auth_totp` удаляется только self-service с кодом владельца, то есть
 *    лечится ручным psql.
 *
 * ## Правило
 *
 * Операция, меняющая безопасность учётки, требует либо второй фактор в ТЕКУЩЕЙ сессии, либо
 * текущий пароль. Условие выбирается по факту: при включённом 2FA код одноразовый и у человека
 * под рукой (телефон), при выключенном — пароль.
 *
 * Второй фактор здесь НЕ переспрашивается: сверяется claim `mfa` в уже выданной сессии. То
 * есть операция требует, чтобы вход уже ПРОШЁЛ со вторым фактором, а не «введите код сейчас».
 * Для смены пароля это ровно то, что нужно (пароль она и так спрашивает), а вот для включения
 * 2FA требовать код в момент включения нельзя — тогда включить его получится только у того,
 * у кого он уже включён.
 *
 * Образец для соседних операций — `requireLinkAccess` в `lib/actions/esa-link.ts`: привязка
 * ЕСА меняет путь входа в учётку и потому требует второго фактора.
 */
export type StepUp = { user: SessionUser; error: null } | { user: null; error: string };

export async function requireAccountSecurity(): Promise<StepUp> {
  const user = await getCurrentUser();
  if (!user) return { user: null, error: 'Требуется авторизация' };

  if (await totpEnabled(user.id)) {
    const payload = await readSessionPayload();
    if (!payload?.mfa) {
      return {
        user: null,
        error: 'Войдите заново с кодом 2FA — операция меняет безопасность учётки',
      };
    }
  }
  return { user, error: null };
}