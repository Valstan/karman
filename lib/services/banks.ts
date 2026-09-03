import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { creditsBank, creditsCredit } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import type { BankCreateInput, BankUpdateInput } from '@/lib/validation/bank';

export type BankListItem = {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  creditsCount: number;
};

/**
 * Банки — ОБЩИЙ справочник на всех (решение владельца 2026-09-03): один человек
 * завёл «Совкомбанк», остальные подтягивают его к своим кредитам, а не заводят
 * четвёртую копию с опечаткой. Поэтому у `credits_bank` нет и не будет `user_id`.
 *
 * Счётчик кредитов при этом СВОЙ: до 03.09 здесь считались кредиты всех, и
 * приглашённый человек видел на общем экране, сколько займов у остальных в
 * каждом банке. Изоляция данных не нарушалась (сами кредиты не показывались),
 * но число — тоже сведения: «у кого-то тут семь кредитов» говорит достаточно.
 */
export async function listBanks(user: SessionUser): Promise<BankListItem[]> {
  return db
    .select({
      id: creditsBank.id,
      name: creditsBank.name,
      address: creditsBank.address,
      phone: creditsBank.phone,
      email: creditsBank.email,
      website: creditsBank.website,
      creditsCount: sql<number>`COUNT(${creditsCredit.id})::int`,
    })
    .from(creditsBank)
    // Условие владения — в ON, а не в WHERE: в WHERE оно превратило бы LEFT JOIN
    // в INNER и выкинуло из справочника все банки, где у ЭТОГО человека кредитов
    // нет, — то есть почти весь справочник у новичка.
    .leftJoin(
      creditsCredit,
      and(eq(creditsCredit.bankId, creditsBank.id), ownership(user, creditsCredit.userId)),
    )
    .groupBy(creditsBank.id)
    .orderBy(asc(creditsBank.name));
}

export async function createBank(input: BankCreateInput): Promise<number> {
  const [created] = await db
    .insert(creditsBank)
    .values({
      name: input.name,
      address: input.address ?? '',
      phone: input.phone ?? '',
      email: input.email ?? '',
      website: input.website ?? '',
    })
    .returning({ id: creditsBank.id });
  return created!.id;
}

export async function updateBank(input: BankUpdateInput): Promise<boolean> {
  const { id, ...fields } = input;
  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.address !== undefined) patch.address = fields.address ?? '';
  if (fields.phone !== undefined) patch.phone = fields.phone ?? '';
  if (fields.email !== undefined) patch.email = fields.email ?? '';
  if (fields.website !== undefined) patch.website = fields.website ?? '';

  if (Object.keys(patch).length === 0) {
    return false;
  }
  patch.updatedAt = sql`NOW()`;

  const result = await db
    .update(creditsBank)
    .set(patch)
    .where(eq(creditsBank.id, id))
    .returning({ id: creditsBank.id });
  return result.length > 0;
}

export type DeleteBankResult = 'deleted' | 'in_use' | 'not_found';

export async function deleteBank(id: number): Promise<DeleteBankResult> {
  const [usage] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(creditsCredit)
    .where(eq(creditsCredit.bankId, id));
  if ((usage?.count ?? 0) > 0) {
    return 'in_use';
  }
  const result = await db
    .delete(creditsBank)
    .where(eq(creditsBank.id, id))
    .returning({ id: creditsBank.id });
  return result.length > 0 ? 'deleted' : 'not_found';
}
