import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { personProfile } from '@/lib/db/schema';
import { emptyProfile, type ProfileValues } from '@/lib/profile/fields';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * Карточка человека. Читает и пишет ТОЛЬКО свою: чужую отдаёт круг
 * (`lib/services/circle.ts`), и там доступ проверяется согласием, а не
 * владением. Разделение намеренное — «прочитать чужую карточку» обязано быть
 * отдельной функцией с отдельной проверкой, иначе однажды кто-нибудь передаст
 * сюда чужой userId и это будет выглядеть законно.
 */

// Форма значений и пустая карточка живут рядом со списком полей (`lib/profile/
// fields.ts`) — модулем без `server-only`, иначе их не видно ни тестам, ни
// клиентским компонентам, которым тот же список нужен для галочек выгрузки.
export type { ProfileValues };

/** Своя карточка; если строки ещё нет — пустая (а не null: форме нужны ключи). */
export async function getOwnProfile(user: SessionUser): Promise<ProfileValues> {
  const [row] = await db
    .select()
    .from(personProfile)
    .where(eq(personProfile.userId, user.id))
    .limit(1);
  if (!row) return emptyProfile();
  return {
    lastName: row.lastName,
    firstName: row.firstName,
    middleName: row.middleName,
    // В БД дата nullable, в форме — пустая строка: `<input type="date">`
    // не умеет null и на нём становится неуправляемым.
    birthDate: row.birthDate ?? '',
    birthPlace: row.birthPlace,
    notes: row.notes,
  };
}

/**
 * Сохраняет свою карточку: одна строка на пользователя, поэтому insert с
 * `onConflictDoUpdate` по unique(user_id) — а не «прочитать и решить». Гонка
 * двух вкладок на «прочитать → нет строки → вставить» дала бы вторую вставку
 * и падение на уникальном индексе.
 */
export async function upsertOwnProfile(
  user: SessionUser,
  input: ProfileValues,
): Promise<void> {
  const values = {
    ...input,
    birthDate: input.birthDate === '' ? null : input.birthDate,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(personProfile)
    .values({ userId: user.id, ...values })
    .onConflictDoUpdate({ target: personProfile.userId, set: values });
}

