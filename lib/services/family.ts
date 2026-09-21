import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { documentsDocument, familyPerson, familyRelation } from '@/lib/db/schema';
import type { TreePerson, TreeRelation } from '@/lib/family/kinship';
import type { FamilyPersonCreateInput, FamilyPersonInput, FamilyRelationInput } from '@/lib/validation/family';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * Древо семьи — данные владельца и только его. Каждая мутация проверяет, что
 * все упомянутые id принадлежат `user.id`: связь «чужой человек → мой» иначе
 * позволила бы читать чужие ФИО через слово родства в своём древе.
 */

export type FamilyTreeData = {
  people: TreePerson[];
  relations: TreeRelation[];
  /** Сколько документов у каждого «чей документ» — для ссылки с узла. */
  documentCounts: Record<string, number>;
};

function toPerson(row: typeof familyPerson.$inferSelect): TreePerson {
  return {
    id: row.id,
    lastName: row.lastName,
    firstName: row.firstName,
    middleName: row.middleName,
    maidenName: row.maidenName,
    nickname: row.nickname,
    sex: row.sex === 'm' || row.sex === 'f' ? row.sex : '',
    born: row.born,
    birthPlace: row.birthPlace,
    died: row.died,
    deathPlace: row.deathPlace,
    residence: row.residence,
    occupation: row.occupation,
    nationality: row.nationality,
    surnameMeaning: row.surnameMeaning,
    notes: row.notes,
    holder: row.holder,
    isSelf: row.isSelf,
    sortOrder: row.sortOrder,
  };
}

export async function getFamilyTree(user: SessionUser): Promise<FamilyTreeData> {
  const [people, relations, counts] = await Promise.all([
    db.select().from(familyPerson).where(eq(familyPerson.userId, user.id)).orderBy(familyPerson.sortOrder, familyPerson.id),
    db.select().from(familyRelation).where(eq(familyRelation.userId, user.id)).orderBy(familyRelation.id),
    db
      .select({ holder: documentsDocument.holder, n: sql<number>`count(*)::int` })
      .from(documentsDocument)
      .where(eq(documentsDocument.userId, user.id))
      .groupBy(documentsDocument.holder),
  ]);
  const documentCounts: Record<string, number> = {};
  for (const c of counts) documentCounts[c.holder] = c.n;
  return {
    people: people.map(toPerson),
    relations: relations.map((r) => ({ id: r.id, kind: r.kind, fromId: r.fromId, toId: r.toId, note: r.note })),
    documentCounts,
  };
}

/** Все ли id — люди этого владельца. */
async function ownsAll(user: SessionUser, ids: number[]): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return true;
  const rows = await db
    .select({ id: familyPerson.id })
    .from(familyPerson)
    .where(and(eq(familyPerson.userId, user.id), inArray(familyPerson.id, unique)));
  return rows.length === unique.length;
}

function personValues(user: SessionUser, p: FamilyPersonInput) {
  return {
    userId: user.id,
    lastName: p.lastName,
    firstName: p.firstName,
    middleName: p.middleName,
    maidenName: p.maidenName,
    nickname: p.nickname,
    sex: p.sex,
    born: p.born,
    birthPlace: p.birthPlace,
    died: p.died,
    deathPlace: p.deathPlace,
    residence: p.residence,
    occupation: p.occupation,
    nationality: p.nationality,
    surnameMeaning: p.surnameMeaning,
    notes: p.notes,
    holder: p.holder,
    isSelf: p.isSelf,
  };
}

/** Точка отсчёта одна: новый «я» снимает флаг с прежнего. */
async function clearSelf(tx: typeof db, userId: number, exceptId?: number): Promise<void> {
  await tx
    .update(familyPerson)
    .set({ isSelf: false })
    .where(
      exceptId === undefined
        ? eq(familyPerson.userId, userId)
        : and(eq(familyPerson.userId, userId), sql`${familyPerson.id} <> ${exceptId}`),
    );
}

export async function createFamilyPerson(user: SessionUser, input: FamilyPersonCreateInput): Promise<number | null> {
  if (input.link && !(await ownsAll(user, [input.link.anchorId]))) return null;
  return db.transaction(async (tx) => {
    if (input.person.isSelf) await clearSelf(tx as unknown as typeof db, user.id);
    const maxRows = await tx
      .select({ max: sql<number>`coalesce(max(${familyPerson.sortOrder}), 0)::int` })
      .from(familyPerson)
      .where(eq(familyPerson.userId, user.id));
    const [row] = await tx
      .insert(familyPerson)
      .values({ ...personValues(user, input.person), sortOrder: (maxRows[0]?.max ?? 0) + 1 })
      .returning({ id: familyPerson.id });
    const id = row!.id;
    if (input.link) {
      const { anchorId, as } = input.link;
      const rel =
        as === 'parent'
          ? { kind: 'parent' as const, fromId: id, toId: anchorId }
          : as === 'child'
            ? { kind: 'parent' as const, fromId: anchorId, toId: id }
            : { kind: 'spouse' as const, fromId: anchorId, toId: id };
      await tx.insert(familyRelation).values({ userId: user.id, ...rel, note: '' });
    }
    return id;
  });
}

export async function updateFamilyPerson(user: SessionUser, id: number, p: FamilyPersonInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (p.isSelf) await clearSelf(tx as unknown as typeof db, user.id, id);
    const rows = await tx
      .update(familyPerson)
      .set({ ...personValues(user, p), updatedAt: new Date().toISOString() })
      .where(and(eq(familyPerson.id, id), eq(familyPerson.userId, user.id)))
      .returning({ id: familyPerson.id });
    return rows.length > 0;
  });
}

export async function deleteFamilyPerson(user: SessionUser, id: number): Promise<boolean> {
  const rows = await db
    .delete(familyPerson)
    .where(and(eq(familyPerson.id, id), eq(familyPerson.userId, user.id)))
    .returning({ id: familyPerson.id });
  return rows.length > 0;
}

/**
 * Порядок людей (для порядка братьев в ряду). Список id целиком — как и поля
 * документа: частичное обновление порядка — это догадка о том, где остальные.
 */
export async function reorderFamilyPeople(user: SessionUser, ids: number[]): Promise<boolean> {
  if (!(await ownsAll(user, ids))) return false;
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx
        .update(familyPerson)
        .set({ sortOrder: i + 1 })
        .where(and(eq(familyPerson.id, ids[i]!), eq(familyPerson.userId, user.id)));
    }
  });
  return true;
}

export async function addFamilyRelation(user: SessionUser, r: FamilyRelationInput): Promise<'ok' | 'not-found' | 'self' | 'exists'> {
  if (r.fromId === r.toId) return 'self';
  if (!(await ownsAll(user, [r.fromId, r.toId]))) return 'not-found';
  // Пара хранится один раз в любом порядке; «родитель» — направленно.
  const dup = await db
    .select({ id: familyRelation.id })
    .from(familyRelation)
    .where(
      and(
        eq(familyRelation.userId, user.id),
        eq(familyRelation.kind, r.kind),
        r.kind === 'spouse'
          ? sql`((${familyRelation.fromId} = ${r.fromId} and ${familyRelation.toId} = ${r.toId}) or (${familyRelation.fromId} = ${r.toId} and ${familyRelation.toId} = ${r.fromId}))`
          : and(eq(familyRelation.fromId, r.fromId), eq(familyRelation.toId, r.toId)),
      ),
    )
    .limit(1);
  if (dup.length > 0) return 'exists';
  await db.insert(familyRelation).values({ userId: user.id, kind: r.kind, fromId: r.fromId, toId: r.toId, note: r.note });
  return 'ok';
}

export async function deleteFamilyRelation(user: SessionUser, id: number): Promise<boolean> {
  const rows = await db
    .delete(familyRelation)
    .where(and(eq(familyRelation.id, id), eq(familyRelation.userId, user.id)))
    .returning({ id: familyRelation.id });
  return rows.length > 0;
}
