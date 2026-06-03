import 'server-only';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { creditsBank, creditsCredit, creditsPayment } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { generateSchedule } from './schedule';
import type { CreditCreateInput, CreditUpdateInput } from '@/lib/validation/credit';
import type { CreditStatus, PaymentStatus, PaymentType } from '@/lib/db/schema';

export type CreditListItem = {
  id: number;
  name: string;
  rawName: string;
  description: string | null;
  amount: string;
  interestRate: string;
  monthlyPayment: string | null;
  paymentType: PaymentType;
  startDate: string;
  status: CreditStatus;
  termMonths: number;
  bankId: number;
  bankName: string;
  bankWebsite: string | null;
};

export type CreditPayment = {
  id: number;
  creditId: number;
  amount: string;
  principalAmount: string | null;
  interestAmount: string | null;
  dueDate: string;
  paidDate: string | null;
  status: PaymentStatus;
};

export type CreditAggregates = {
  paidAmount: string;
  remainingAmount: string;
  paymentsTotal: number;
  paymentsPaid: number;
  paymentsScheduled: number;
  paymentsOverdue: number;
};

export type CreditDetail = CreditListItem & {
  aggregates: CreditAggregates;
  payments: CreditPayment[];
};

const creditColumns = {
  id: creditsCredit.id,
  rawName: creditsCredit.name,
  description: creditsCredit.description,
  amount: creditsCredit.amount,
  interestRate: creditsCredit.interestRate,
  monthlyPayment: creditsCredit.monthlyPayment,
  paymentType: creditsCredit.paymentType,
  startDate: creditsCredit.startDate,
  status: creditsCredit.status,
  termMonths: creditsCredit.termMonths,
  bankId: creditsBank.id,
  bankName: creditsBank.name,
  bankWebsite: creditsBank.website,
};

function withDisplayName(row: Omit<CreditListItem, 'name'>): CreditListItem {
  return { ...row, name: row.rawName?.trim() ? row.rawName : row.bankName };
}

export async function listCredits(user: SessionUser): Promise<CreditListItem[]> {
  const rows = await db
    .select(creditColumns)
    .from(creditsCredit)
    .innerJoin(creditsBank, eq(creditsBank.id, creditsCredit.bankId))
    .where(ownership(user, creditsCredit.userId))
    .orderBy(desc(creditsCredit.startDate), desc(creditsCredit.id));
  return rows.map(withDisplayName);
}

async function findCredit(user: SessionUser, id: number): Promise<CreditListItem | null> {
  const rows = await db
    .select(creditColumns)
    .from(creditsCredit)
    .innerJoin(creditsBank, eq(creditsBank.id, creditsCredit.bankId))
    .where(and(eq(creditsCredit.id, id), ownership(user, creditsCredit.userId)))
    .limit(1);
  return rows[0] ? withDisplayName(rows[0]) : null;
}

export async function getCreditDetail(user: SessionUser, id: number): Promise<CreditDetail | null> {
  const credit = await findCredit(user, id);
  if (!credit) {
    return null;
  }

  const [aggRow] = await db
    .select({
      paidAmount: sql<string>`COALESCE(SUM(${creditsPayment.amount}) FILTER (WHERE ${creditsPayment.status} = 'paid'), 0)::text`,
      remainingAmount: sql<string>`COALESCE(SUM(${creditsPayment.amount}) FILTER (WHERE ${creditsPayment.status} IN ('scheduled','overdue')), 0)::text`,
      paymentsTotal: sql<number>`COUNT(*)::int`,
      paymentsPaid: sql<number>`COUNT(*) FILTER (WHERE ${creditsPayment.status} = 'paid')::int`,
      paymentsScheduled: sql<number>`COUNT(*) FILTER (WHERE ${creditsPayment.status} = 'scheduled')::int`,
      paymentsOverdue: sql<number>`COUNT(*) FILTER (WHERE ${creditsPayment.status} = 'overdue')::int`,
    })
    .from(creditsPayment)
    .where(eq(creditsPayment.creditId, id));

  const payments = await db
    .select({
      id: creditsPayment.id,
      creditId: creditsPayment.creditId,
      amount: creditsPayment.amount,
      principalAmount: creditsPayment.principalAmount,
      interestAmount: creditsPayment.interestAmount,
      dueDate: creditsPayment.dueDate,
      paidDate: creditsPayment.paidDate,
      status: creditsPayment.status,
    })
    .from(creditsPayment)
    .where(eq(creditsPayment.creditId, id))
    .orderBy(asc(creditsPayment.dueDate), asc(creditsPayment.id));

  return {
    ...credit,
    aggregates: aggRow ?? {
      paidAmount: '0',
      remainingAmount: '0',
      paymentsTotal: 0,
      paymentsPaid: 0,
      paymentsScheduled: 0,
      paymentsOverdue: 0,
    },
    payments,
  };
}

export async function createCredit(user: SessionUser, input: CreditCreateInput): Promise<number> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(creditsCredit)
      .values({
        name: input.name ?? '',
        description: input.description || null,
        amount: input.amount,
        interestRate: input.interestRate,
        monthlyPayment: input.monthlyPayment ?? null,
        paymentType: input.paymentType,
        startDate: input.startDate,
        status: input.status,
        termMonths: input.termMonths,
        bankId: input.bankId,
        userId: user.id,
      })
      .returning({ id: creditsCredit.id });

    const creditId = created!.id;

    if (input.generateSchedule) {
      const schedule = generateSchedule({
        amount: input.amount,
        annualRatePercent: input.interestRate,
        termMonths: input.termMonths,
        startDate: input.startDate,
        paymentType: input.paymentType,
        monthlyPayment: input.monthlyPayment,
      });
      if (schedule.length > 0) {
        await tx.insert(creditsPayment).values(
          schedule.map((s) => ({
            creditId,
            amount: s.amount,
            // principal/interest в БД NOT NULL; для типа «other» график их не
            // считает (null) → пишем '0.00' (разбивка не определена).
            principalAmount: s.principalAmount ?? '0.00',
            interestAmount: s.interestAmount ?? '0.00',
            dueDate: s.dueDate,
            status: s.status,
          })),
        );
      }
    }

    return creditId;
  });
}

export async function updateCredit(user: SessionUser, input: CreditUpdateInput): Promise<boolean> {
  const { id, ...fields } = input;
  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.description !== undefined) patch.description = fields.description || null;
  if (fields.bankId !== undefined) patch.bankId = fields.bankId;
  if (fields.amount !== undefined) patch.amount = fields.amount;
  if (fields.interestRate !== undefined) patch.interestRate = fields.interestRate;
  if (fields.monthlyPayment !== undefined) patch.monthlyPayment = fields.monthlyPayment;
  if (fields.paymentType !== undefined) patch.paymentType = fields.paymentType;
  if (fields.startDate !== undefined) patch.startDate = fields.startDate;
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.termMonths !== undefined) patch.termMonths = fields.termMonths;

  if (Object.keys(patch).length === 0) {
    return false;
  }
  patch.updatedAt = sql`NOW()`;

  const result = await db
    .update(creditsCredit)
    .set(patch)
    .where(and(eq(creditsCredit.id, id), ownership(user, creditsCredit.userId)))
    .returning({ id: creditsCredit.id });

  return result.length > 0;
}

export async function deleteCredit(user: SessionUser, id: number): Promise<boolean> {
  // FK credits_payment.credit_id — БЕЗ ON DELETE CASCADE (Django каскадит в коде),
  // поэтому сначала удаляем платежи, затем кредит — в одной транзакции.
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: creditsCredit.id })
      .from(creditsCredit)
      .where(and(eq(creditsCredit.id, id), ownership(user, creditsCredit.userId)))
      .limit(1);
    if (!owned) {
      return false;
    }
    await tx.delete(creditsPayment).where(eq(creditsPayment.creditId, id));
    await tx.delete(creditsCredit).where(eq(creditsCredit.id, id));
    return true;
  });
}

/**
 * Перегенерация графика: удаляет только будущие `scheduled` платежи и
 * создаёт новый график. Оплаченные (`paid`) и просроченные строки не трогаются.
 */
export async function regenerateSchedule(user: SessionUser, id: number): Promise<boolean> {
  const credit = await findCredit(user, id);
  if (!credit) {
    return false;
  }

  const schedule = generateSchedule({
    amount: credit.amount,
    annualRatePercent: credit.interestRate,
    termMonths: credit.termMonths,
    startDate: credit.startDate,
    paymentType: credit.paymentType,
    monthlyPayment: credit.monthlyPayment,
  });

  await db.transaction(async (tx) => {
    await tx
      .delete(creditsPayment)
      .where(and(eq(creditsPayment.creditId, id), eq(creditsPayment.status, 'scheduled')));
    if (schedule.length > 0) {
      await tx.insert(creditsPayment).values(
        schedule.map((s) => ({
          creditId: id,
          amount: s.amount,
          principalAmount: s.principalAmount ?? '0.00',
          interestAmount: s.interestAmount ?? '0.00',
          dueDate: s.dueDate,
          status: s.status,
        })),
      );
    }
  });

  return true;
}
