import 'server-only';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { creditsBank, creditsCredit } from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
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

// Банки — общий справочник (в схеме нет user_id). Любой аутентифицированный
// пользователь видит весь список (нужно для выбора банка при создании кредита).
export async function listBanks(_user: SessionUser): Promise<BankListItem[]> {
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
    .leftJoin(creditsCredit, eq(creditsCredit.bankId, creditsBank.id))
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
