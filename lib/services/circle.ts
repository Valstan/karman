import 'server-only';
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  authUser,
  circle,
  circleMember,
  documentField,
  documentFile,
  documentsDocument,
  personProfile,
} from '@/lib/db/schema';
import { memberState, type MemberState } from '@/lib/circle/state';
import { displayName, emptyProfile, type ProfileValues } from '@/lib/profile/fields';
import { isImagePath } from '@/lib/storage/media-paths';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * Круг — единственный способ увидеть чужие данные в КАРМАНе.
 *
 * ВАЖНОЕ ПРАВИЛО ЭТОГО МОДУЛЯ: здесь НЕ используется `ownership()`. Тот хелпер
 * отвечает на вопрос «моя ли это строка» и с 2026-09-03 не знает исключений —
 * в том числе для суперпользователя. Здесь вопрос другой: «открыл ли мне этот
 * человек доступ». Ответ даёт только пара согласий: я и он состоим в одном
 * круге, и у ОБОИХ проставлен `consented_at`, и никто не вышел.
 *
 * Смешивать эти два вопроса в одной функции нельзя: тогда любая будущая правка
 * «а давайте тут тоже пустим» расширяла бы сразу оба.
 */

/** Условие «строка участия действующая»: согласился и не вышел. */
function activeMember() {
  return and(isNotNull(circleMember.consentedAt), isNull(circleMember.leftAt));
}

/**
 * id людей, чьи данные мне открыты: те, кто состоит со мной хотя бы в одном
 * круге, где согласие есть у обоих. Себя в списке нет — свои данные читаются
 * своими же функциями.
 */
export async function visiblePeopleIds(user: SessionUser): Promise<number[]> {
  const mine = db
    .select({ circleId: circleMember.circleId })
    .from(circleMember)
    .where(and(eq(circleMember.userId, user.id), activeMember()));

  const rows = await db
    .selectDistinct({ userId: circleMember.userId })
    .from(circleMember)
    .where(
      and(
        inArray(circleMember.circleId, mine),
        ne(circleMember.userId, user.id),
        activeMember(),
      ),
    );
  return rows.map((r) => r.userId);
}

export type CirclePerson = {
  userId: number;
  username: string;
  name: string;
  profile: ProfileValues;
};

/** Карточки всех, кто открыл мне доступ (включая мою — она первая). */
export async function listVisiblePeople(user: SessionUser): Promise<CirclePerson[]> {
  const otherIds = await visiblePeopleIds(user);
  const ids = [user.id, ...otherIds];

  const rows = await db
    .select({
      userId: authUser.id,
      username: authUser.username,
      profile: personProfile,
    })
    .from(authUser)
    .leftJoin(personProfile, eq(personProfile.userId, authUser.id))
    .where(inArray(authUser.id, ids));

  const people = rows.map((row) => {
    const profile = row.profile ? profileFromRow(row.profile) : emptyProfile();
    return {
      userId: row.userId,
      username: row.username,
      name: displayName(profile, row.username),
      profile,
    };
  });

  // Свой всегда первым, остальные по имени: на экране выгрузки первым делом
  // ищут себя, а дальше — фамилию.
  return people.sort((a, b) => {
    if (a.userId === user.id) return -1;
    if (b.userId === user.id) return 1;
    return a.name.localeCompare(b.name, 'ru');
  });
}

function profileFromRow(row: typeof personProfile.$inferSelect): ProfileValues {
  return {
    lastName: row.lastName,
    firstName: row.firstName,
    middleName: row.middleName,
    birthDate: row.birthDate ?? '',
    birthPlace: row.birthPlace,
    snils: row.snils,
    inn: row.inn,
    registrationAddress: row.registrationAddress,
    actualAddress: row.actualAddress,
    employer: row.employer,
    jobTitle: row.jobTitle,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
  };
}

export type CircleDocument = {
  id: number;
  ownerUserId: number;
  title: string;
  documentType: string;
  documentNumber: string;
  issueDate: string | null;
  expiryDate: string | null;
  issuingAuthority: string;
  fields: { name: string; value: string }[];
  files: { id: number; originalName: string; isImage: boolean }[];
};

/**
 * Документы людей круга (и свои) — с полями и файлами, для экрана выгрузки.
 * Список владельцев считается ЗДЕСЬ, а не приходит параметром: параметр
 * означал бы, что вызывающий сам решает, чьи документы показать.
 */
export async function listVisibleDocuments(user: SessionUser): Promise<CircleDocument[]> {
  const ids = [user.id, ...(await visiblePeopleIds(user))];

  const docs = await db
    .select({
      id: documentsDocument.id,
      ownerUserId: documentsDocument.userId,
      title: documentsDocument.title,
      documentType: documentsDocument.documentType,
      documentNumber: documentsDocument.documentNumber,
      issueDate: documentsDocument.issueDate,
      expiryDate: documentsDocument.expiryDate,
      issuingAuthority: documentsDocument.issuingAuthority,
    })
    .from(documentsDocument)
    .where(inArray(documentsDocument.userId, ids))
    .orderBy(documentsDocument.userId, documentsDocument.id);

  if (docs.length === 0) return [];
  const docIds = docs.map((d) => d.id);

  const [fields, files] = await Promise.all([
    db
      .select({
        documentId: documentField.documentId,
        name: documentField.name,
        value: documentField.value,
      })
      .from(documentField)
      .where(inArray(documentField.documentId, docIds))
      .orderBy(documentField.position, documentField.id),
    db
      .select({
        documentId: documentFile.documentId,
        id: documentFile.id,
        originalName: documentFile.originalName,
        path: documentFile.path,
      })
      .from(documentFile)
      .where(inArray(documentFile.documentId, docIds))
      .orderBy(documentFile.position, documentFile.id),
  ]);

  const fieldsByDoc = new Map<number, { name: string; value: string }[]>();
  for (const f of fields) {
    const list = fieldsByDoc.get(f.documentId) ?? [];
    list.push({ name: f.name, value: f.value });
    fieldsByDoc.set(f.documentId, list);
  }
  const filesByDoc = new Map<number, { id: number; originalName: string; isImage: boolean }[]>();
  for (const f of files) {
    const list = filesByDoc.get(f.documentId) ?? [];
    list.push({ id: f.id, originalName: f.originalName, isImage: isImagePath(f.path) });
    filesByDoc.set(f.documentId, list);
  }

  return docs.map((d) => ({
    ...d,
    fields: fieldsByDoc.get(d.id) ?? [],
    files: filesByDoc.get(d.id) ?? [],
  }));
}

export type CircleMemberView = {
  userId: number;
  username: string;
  name: string;
  state: MemberState;
};

export type CircleView = {
  id: number;
  name: string;
  ownerUserId: number;
  isOwner: boolean;
  /** Моё состояние в этом круге — от него зависит, что показывать. */
  myState: MemberState;
  members: CircleMemberView[];
};

/** Круги, где я состою в любом состоянии (включая ещё не принятые приглашения). */
export async function listMyCircles(user: SessionUser): Promise<CircleView[]> {
  const mine = await db
    .select({
      circleId: circleMember.circleId,
      name: circle.name,
      ownerUserId: circle.ownerUserId,
      consentedAt: circleMember.consentedAt,
      declinedAt: circleMember.declinedAt,
      leftAt: circleMember.leftAt,
    })
    .from(circleMember)
    .innerJoin(circle, eq(circle.id, circleMember.circleId))
    .where(eq(circleMember.userId, user.id))
    .orderBy(circle.name);

  if (mine.length === 0) return [];
  const circleIds = mine.map((m) => m.circleId);

  const members = await db
    .select({
      circleId: circleMember.circleId,
      userId: circleMember.userId,
      username: authUser.username,
      lastName: personProfile.lastName,
      firstName: personProfile.firstName,
      middleName: personProfile.middleName,
      consentedAt: circleMember.consentedAt,
      declinedAt: circleMember.declinedAt,
      leftAt: circleMember.leftAt,
    })
    .from(circleMember)
    .innerJoin(authUser, eq(authUser.id, circleMember.userId))
    .leftJoin(personProfile, eq(personProfile.userId, circleMember.userId))
    .where(inArray(circleMember.circleId, circleIds));

  const byCircle = new Map<number, CircleMemberView[]>();
  for (const m of members) {
    const list = byCircle.get(m.circleId) ?? [];
    const name = displayName(
      {
        ...emptyProfile(),
        lastName: m.lastName ?? '',
        firstName: m.firstName ?? '',
        middleName: m.middleName ?? '',
      },
      m.username,
    );
    list.push({ userId: m.userId, username: m.username, name, state: memberState(m) });
    byCircle.set(m.circleId, list);
  }

  return mine.map((c) => ({
    id: c.circleId,
    name: c.name,
    ownerUserId: c.ownerUserId,
    isOwner: c.ownerUserId === user.id,
    myState: memberState(c),
    members: (byCircle.get(c.circleId) ?? []).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
  }));
}

export type CircleActionResult = { ok: true } | { ok: false; error: string };

/** Заводит круг. Создатель сразу согласившийся участник — создать и не войти нельзя. */
export async function createCircle(user: SessionUser, name: string): Promise<CircleActionResult> {
  await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(circle)
      .values({ name, ownerUserId: user.id })
      .returning({ id: circle.id });
    await tx.insert(circleMember).values({
      circleId: created!.id,
      userId: user.id,
      consentedAt: sql`NOW()`,
    });
  });
  return { ok: true };
}

/** Переименовывает круг (только владелец). */
export async function renameCircle(
  user: SessionUser,
  circleId: number,
  name: string,
): Promise<CircleActionResult> {
  const result = await db
    .update(circle)
    .set({ name, updatedAt: sql`NOW()` })
    .where(and(eq(circle.id, circleId), eq(circle.ownerUserId, user.id)))
    .returning({ id: circle.id });
  if (result.length === 0) return { ok: false, error: 'Круг не найден или вы не его владелец' };
  return { ok: true };
}

/**
 * Приглашает человека по ТОЧНОМУ логину. Не по списку пользователей намеренно:
 * список — это перечень всех людей системы, и владельцу круга он не положен
 * (его видит только суперпользователь, `lib/services/users.ts`).
 */
export async function inviteToCircle(
  user: SessionUser,
  circleId: number,
  username: string,
): Promise<CircleActionResult> {
  const [owned] = await db
    .select({ id: circle.id })
    .from(circle)
    .where(and(eq(circle.id, circleId), eq(circle.ownerUserId, user.id)))
    .limit(1);
  if (!owned) return { ok: false, error: 'Круг не найден или вы не его владелец' };

  const [target] = await db
    .select({ id: authUser.id, isActive: authUser.isActive })
    .from(authUser)
    .where(sql`lower(${authUser.username}) = lower(${username})`)
    .limit(1);
  if (!target || !target.isActive) {
    return { ok: false, error: `Пользователь «${username}» не найден` };
  }
  if (target.id === user.id) return { ok: false, error: 'Вы уже в этом круге' };

  const [existing] = await db
    .select({ id: circleMember.id, leftAt: circleMember.leftAt })
    .from(circleMember)
    .where(and(eq(circleMember.circleId, circleId), eq(circleMember.userId, target.id)))
    .limit(1);

  if (existing) {
    // Повторное приглашение вышедшего или отказавшегося: обнуляем ответ, но
    // НЕ проставляем согласие — согласие даёт только сам человек.
    await db
      .update(circleMember)
      .set({ invitedAt: sql`NOW()`, declinedAt: null, leftAt: null, consentedAt: null })
      .where(eq(circleMember.id, existing.id));
    return { ok: true };
  }

  await db.insert(circleMember).values({ circleId, userId: target.id });
  return { ok: true };
}

/** Ответ на приглашение: согласие или отказ. Только за себя. */
export async function respondToInvite(
  user: SessionUser,
  circleId: number,
  accept: boolean,
): Promise<CircleActionResult> {
  const patch = accept
    ? { consentedAt: sql`NOW()`, declinedAt: null, leftAt: null }
    : { consentedAt: null, declinedAt: sql`NOW()` };
  const result = await db
    .update(circleMember)
    .set(patch)
    .where(and(eq(circleMember.circleId, circleId), eq(circleMember.userId, user.id)))
    .returning({ id: circleMember.id });
  if (result.length === 0) return { ok: false, error: 'Приглашение не найдено' };
  return { ok: true };
}

/** Выход из круга по своей воле. Данные остаются, видимость пропадает сразу. */
export async function leaveCircle(
  user: SessionUser,
  circleId: number,
): Promise<CircleActionResult> {
  const result = await db
    .update(circleMember)
    .set({ leftAt: sql`NOW()` })
    .where(and(eq(circleMember.circleId, circleId), eq(circleMember.userId, user.id)))
    .returning({ id: circleMember.id });
  if (result.length === 0) return { ok: false, error: 'Вы не состоите в этом круге' };
  return { ok: true };
}

/** Владелец исключает участника. Себя исключить нельзя — только удалить круг. */
export async function removeFromCircle(
  user: SessionUser,
  circleId: number,
  targetUserId: number,
): Promise<CircleActionResult> {
  if (targetUserId === user.id) {
    return { ok: false, error: 'Владелец не может исключить себя — удалите круг целиком' };
  }
  const [owned] = await db
    .select({ id: circle.id })
    .from(circle)
    .where(and(eq(circle.id, circleId), eq(circle.ownerUserId, user.id)))
    .limit(1);
  if (!owned) return { ok: false, error: 'Круг не найден или вы не его владелец' };

  await db
    .update(circleMember)
    .set({ leftAt: sql`NOW()` })
    .where(and(eq(circleMember.circleId, circleId), eq(circleMember.userId, targetUserId)));
  return { ok: true };
}

/** Удаляет круг целиком (только владелец). Данные людей не трогаются. */
export async function deleteCircle(
  user: SessionUser,
  circleId: number,
): Promise<CircleActionResult> {
  const result = await db
    .delete(circle)
    .where(and(eq(circle.id, circleId), eq(circle.ownerUserId, user.id)))
    .returning({ id: circle.id });
  if (result.length === 0) return { ok: false, error: 'Круг не найден или вы не его владелец' };
  return { ok: true };
}
