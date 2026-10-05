import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { secretsCard, secretsCardField, secretsProject } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import {
  cardFieldAad,
  cardTitleAad,
  decryptSecret,
  encryptSecret,
} from '@/lib/secrets/crypto';
import { actorOwner } from '@/lib/secrets/actor';
import { parseCsv } from '@/lib/csv-parse';
import { mapCsvToCards } from '@/lib/secrets/csv-import';
import type {
  SecretCardCreateInput,
  SecretCardFieldUpsertInput,
  SecretCardUpdateInput,
} from '@/lib/validation/secret';
import { isoNow, logAudit, ownedProjectId } from './internal';

/**
 * Карточки секретов и их поля — зона 2 `secrets.ts` (вынос 05.10, R3).
 *
 * Отдельная зона потому, что здесь другая единица работы: не «ключ в комнате»,
 * а «карточка с зашифрованным наименованием и произвольными полями». Название
 * шифруется с AAD от id карточки, поэтому создание идёт транзакцией
 * (insert плейсхолдера → update), а значения полей — по AAD (card_id, name):
 * переставить поле между карточками в БД нельзя, расшифровка это увидит.
 *
 * Все точки входа гейтят владельца сами: `ownedProjectId` (комната) и
 * `ownedCardId` (карточка) — суперпользователь исключений не имеет
 * (см. `lib/auth/rbac.ts`).
 */

export type SecretCardFieldMeta = { id: number; name: string; kind: string; position: number };
export type SecretCardListItem = {
  id: number;
  envKey: string | null;
  title: string;
  fields: SecretCardFieldMeta[];
  updatedAt: string;
};

/**
 * Карточки комнаты с расшифрованными наименованиями и метаданными полей
 * (значения полей НЕ возвращаются — расшифровка по клику через revealCardField).
 */
export async function listCards(user: SessionUser, projectId: number): Promise<SecretCardListItem[] | null> {
  if ((await ownedProjectId(user, projectId)) === null) return null;
  const cards = await db
    .select()
    .from(secretsCard)
    .where(eq(secretsCard.projectId, projectId))
    .orderBy(desc(secretsCard.id));
  if (cards.length === 0) return [];

  const fields = await db
    .select({
      id: secretsCardField.id,
      cardId: secretsCardField.cardId,
      name: secretsCardField.name,
      kind: secretsCardField.kind,
      position: secretsCardField.position,
    })
    .from(secretsCardField)
    .innerJoin(secretsCard, eq(secretsCardField.cardId, secretsCard.id))
    .where(eq(secretsCard.projectId, projectId))
    .orderBy(secretsCardField.position, secretsCardField.id);

  return cards.map((c) => ({
    id: c.id,
    envKey: c.envKey,
    title: decryptSecret({ ciphertext: c.titleCt, iv: c.titleIv, authTag: c.titleTag }, cardTitleAad(c.id)),
    fields: fields.filter((f) => f.cardId === c.id).map(({ cardId: _cardId, ...f }) => f),
    updatedAt: c.updatedAt,
  }));
}

/**
 * Создаёт карточку. Наименование шифруется с AAD от id карточки, поэтому
 * insert и шифрование идут в одной транзакции (insert плейсхолдера → update).
 */
export async function createCard(user: SessionUser, input: SecretCardCreateInput): Promise<number | null> {
  if ((await ownedProjectId(user, input.projectId)) === null) return null;
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(secretsCard)
      .values({ projectId: input.projectId, envKey: input.envKey ?? null, titleCt: '', titleIv: '', titleTag: '' })
      .returning({ id: secretsCard.id });
    const id = created!.id;
    const enc = encryptSecret(input.title, cardTitleAad(id));
    await tx
      .update(secretsCard)
      .set({ titleCt: enc.ciphertext, titleIv: enc.iv, titleTag: enc.authTag })
      .where(eq(secretsCard.id, id));
    return id;
  });
}

/** id карточки, если её комната принадлежит пользователю; иначе null. */
async function ownedCardId(user: SessionUser, cardId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: secretsCard.id })
    .from(secretsCard)
    .innerJoin(secretsProject, eq(secretsCard.projectId, secretsProject.id))
    .where(and(eq(secretsCard.id, cardId), ownership(user, secretsProject.userId)))
    .limit(1);
  return row?.id ?? null;
}

export async function updateCard(user: SessionUser, input: SecretCardUpdateInput): Promise<boolean> {
  if ((await ownedCardId(user, input.id)) === null) return false;
  const enc = encryptSecret(input.title, cardTitleAad(input.id));
  await db
    .update(secretsCard)
    .set({
      envKey: input.envKey ?? null,
      titleCt: enc.ciphertext,
      titleIv: enc.iv,
      titleTag: enc.authTag,
      updatedAt: isoNow(),
    })
    .where(eq(secretsCard.id, input.id));
  return true;
}

export async function deleteCard(user: SessionUser, cardId: number): Promise<boolean> {
  if ((await ownedCardId(user, cardId)) === null) return false;
  await db.delete(secretsCard).where(eq(secretsCard.id, cardId));
  return true;
}

/** Создаёт/обновляет поле карточки (по уникальному (card_id, name)). */
export async function upsertCardField(user: SessionUser, input: SecretCardFieldUpsertInput): Promise<boolean> {
  if ((await ownedCardId(user, input.cardId)) === null) return false;
  const enc = encryptSecret(input.value, cardFieldAad(input.cardId, input.name));
  const [posRow] = await db
    .select({ maxPos: sql<number>`coalesce(max(position), 0)::int` })
    .from(secretsCardField)
    .where(eq(secretsCardField.cardId, input.cardId));
  const maxPos = posRow?.maxPos ?? 0;
  await db
    .insert(secretsCardField)
    .values({
      cardId: input.cardId,
      name: input.name,
      kind: input.kind,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      position: maxPos + 1,
    })
    .onConflictDoUpdate({
      target: [secretsCardField.cardId, secretsCardField.name],
      set: { kind: input.kind, ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, updatedAt: isoNow() },
    });
  await db.update(secretsCard).set({ updatedAt: isoNow() }).where(eq(secretsCard.id, input.cardId));
  return true;
}

export async function deleteCardField(user: SessionUser, fieldId: number): Promise<boolean> {
  const [field] = await db
    .select({ id: secretsCardField.id, cardId: secretsCardField.cardId })
    .from(secretsCardField)
    .where(eq(secretsCardField.id, fieldId))
    .limit(1);
  if (!field || (await ownedCardId(user, field.cardId)) === null) return false;
  await db.delete(secretsCardField).where(eq(secretsCardField.id, fieldId));
  return true;
}

/** Расшифровывает значение поля карточки (показ владельцу по клику). null — нет доступа. */
export async function revealCardField(user: SessionUser, fieldId: number): Promise<string | null> {
  const [field] = await db
    .select({
      cardId: secretsCardField.cardId,
      name: secretsCardField.name,
      ciphertext: secretsCardField.ciphertext,
      iv: secretsCardField.iv,
      authTag: secretsCardField.authTag,
    })
    .from(secretsCardField)
    .where(eq(secretsCardField.id, fieldId))
    .limit(1);
  if (!field || (await ownedCardId(user, field.cardId)) === null) return null;
  const value = decryptSecret(field, cardFieldAad(field.cardId, field.name));
  const [card] = await db
    .select({ projectId: secretsCard.projectId })
    .from(secretsCard)
    .where(eq(secretsCard.id, field.cardId))
    .limit(1);
  await logAudit(
    card?.projectId ?? null,
    null,
    'reveal_card_field',
    `card=${field.cardId} field=${field.name}`,
    null,
    actorOwner(user.id),
  );
  return value;
}

/**
 * Импорт карточек из CSV (vault Ф3). Парсит, мапит колонки (браузерные
 * экспорты), создаёт карточки + поля с шифрованием. Каждая карточка — своя
 * транзакция (одна битая строка не откатывает весь импорт). null — нет доступа.
 */
export async function importCards(
  user: SessionUser,
  projectId: number,
  csvText: string,
): Promise<{ imported: number; skipped: number } | null> {
  if ((await ownedProjectId(user, projectId)) === null) return null;
  const { cards, skipped } = mapCsvToCards(parseCsv(csvText));

  let imported = 0;
  for (const card of cards) {
    await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(secretsCard)
        .values({ projectId, envKey: null, titleCt: '', titleIv: '', titleTag: '' })
        .returning({ id: secretsCard.id });
      const id = created!.id;
      const t = encryptSecret(card.title, cardTitleAad(id));
      await tx
        .update(secretsCard)
        .set({ titleCt: t.ciphertext, titleIv: t.iv, titleTag: t.authTag })
        .where(eq(secretsCard.id, id));
      if (card.fields.length > 0) {
        await tx.insert(secretsCardField).values(
          card.fields.map((f, idx) => {
            const enc = encryptSecret(f.value, cardFieldAad(id, f.name));
            return {
              cardId: id,
              name: f.name,
              kind: f.kind,
              ciphertext: enc.ciphertext,
              iv: enc.iv,
              authTag: enc.authTag,
              position: idx + 1,
            };
          }),
        );
      }
    });
    imported += 1;
  }
  return { imported, skipped };
}