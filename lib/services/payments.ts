import 'server-only';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { creditsBank, creditsCredit, creditsPayment } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import type { PaymentCreateInput, PaymentUpdateInput } from '@/lib/validation/payment';
import type { PaymentStatus } from '@/lib/db/schema';

export type PaymentListItem = {
  id: number;
  creditId: number;
  creditName: string;
  bankName: string;
  amount: string;
  principalAmount: string | null;
  interestAmount: string | null;
  dueDate: string;
  paidDate: string | null;
  status: PaymentStatus;
};

/** Возвращает user_id владельца кредита платежа, либо null если платёж не существует. */
async function ownerOfPayment(paymentId: number): Promise<number | null> {
  const rows = await db
    .select({ userId: creditsCredit.userId })
    .from(creditsPayment)
    .innerJoin(creditsCredit, eq(creditsCredit.id, creditsPayment.creditId))
    .where(eq(creditsPayment.id, paymentId))
    .limit(1);
  return rows[0]?.userId ?? null;
}

function canAccess(user: SessionUser, ownerId: number | null): boolean {
  if (ownerId === null) return false;
  return user.isSuperuser || ownerId === user.id;
}

async function ownsCredit(user: SessionUser, creditId: number): Promise<boolean> {
  const rows = await db
    .select({ userId: creditsCredit.userId })
    .from(creditsCredit)
    .where(and(eq(creditsCredit.id, creditId), ownership(user, creditsCredit.userId)))
    .limit(1);
  return rows.length > 0;
}

export async function listPayments(user: SessionUser): Promise<PaymentListItem[]> {
  const rows = await db
    .select({
      id: creditsPayment.id,
      creditId: creditsPayment.creditId,
      rawCreditName: creditsCredit.name,
      bankName: creditsBank.name,
      amount: creditsPayment.amount,
      principalAmount: creditsPayment.principalAmount,
      interestAmount: creditsPayment.interestAmount,
      dueDate: creditsPayment.dueDate,
      paidDate: creditsPayment.paidDate,
      status: creditsPayment.status,
    })
    .from(creditsPayment)
    .innerJoin(creditsCredit, eq(creditsCredit.id, creditsPayment.creditId))
    .innerJoin(creditsBank, eq(creditsBank.id, creditsCredit.bankId))
    .where(ownership(user, creditsCredit.userId))
    .orderBy(asc(creditsPayment.dueDate), desc(creditsPayment.id));

  return rows.map(({ rawCreditName, ...r }) => ({
    ...r,
    creditName: rawCreditName?.trim() ? rawCreditName : r.bankName,
  }));
}

export async function createPayment(user: SessionUser, input: PaymentCreateInput): Promise<number | null> {
  if (!(await ownsCredit(user, input.creditId))) {
    return null;
  }
  const [created] = await db
    .insert(creditsPayment)
    .values({
      creditId: input.creditId,
      amount: input.amount,
      principalAmount: input.principalAmount ?? null,
      interestAmount: input.interestAmount ?? null,
      dueDate: input.dueDate,
      paidDate: input.paidDate ?? null,
      status: input.status,
    })
    .returning({ id: creditsPayment.id });
  return created!.id;
}

export async function updatePayment(user: SessionUser, input: PaymentUpdateInput): Promise<boolean> {
  if (!canAccess(user, await ownerOfPayment(input.id))) {
    return false;
  }

  const patch: Record<string, unknown> = {};
  if (input.amount !== undefined) patch.amount = input.amount;
  if (input.principalAmount !== undefined) patch.principalAmount = input.principalAmount;
  if (input.interestAmount !== undefined) patch.interestAmount = input.interestAmount;
  if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
  if (input.paidDate !== undefined) patch.paidDate = input.paidDate;
  if (input.status !== undefined) patch.status = input.status;

  if (Object.keys(patch).length === 0) {
    return false;
  }

  await db.update(creditsPayment).set(patch).where(eq(creditsPayment.id, input.id));
  return true;
}

export async function deletePayment(user: SessionUser, id: number): Promise<boolean> {
  if (!canAccess(user, await ownerOfPayment(id))) {
    return false;
  }
  await db.delete(creditsPayment).where(eq(creditsPayment.id, id));
  return true;
}
