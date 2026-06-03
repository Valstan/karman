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
 * Условие фильтрации по владельцу. Для superuser возвращает undefined
 * (фильтр снимается — видит все строки), иначе `column = user.id`.
 * Совпадает с логикой старого Express-API.
 */
export function ownership(user: SessionUser, column: PgColumn): SQL | undefined {
  return user.isSuperuser ? undefined : eq(column, user.id);
}
