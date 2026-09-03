import { eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

export type SessionUser = {
  id: number;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  isSuperuser: boolean;
};

/**
 * Условие фильтрации по владельцу: `column = user.id`, БЕЗ исключений.
 *
 * Раньше здесь стояло `user.isSuperuser ? undefined : …` — для суперпользователя
 * фильтр снимался целиком, и он видел чужие кредиты, документы и напоминания
 * подмешанными в свои (отличить было не по чему: ни в одном DTO нет владельца).
 * Наследие однопользовательского Express-API: пока человек в системе был один,
 * разницы не существовало.
 *
 * Решение владельца 2026-09-03: суперпользователь администрирует АККАУНТЫ
 * (заводит, блокирует, сбрасывает пароль), но чужие данные видит только через
 * явное согласие человека — на общих правах со всеми. Иначе согласие в круге
 * было бы декоративным: владелец и так видел бы всё.
 *
 * Права остаются у суперпользователя там, где это administrative action, а не
 * чтение чужого: `lib/services/users.ts`, заведение паспортных личностей
 * (`lib/services/passport.ts`), выбор владельца комнаты при self-serve.
 */
export function ownership(user: SessionUser, column: PgColumn): SQL {
  return eq(column, user.id);
}
