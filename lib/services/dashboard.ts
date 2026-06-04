import 'server-only';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  creditsBank,
  creditsCredit,
  creditsPayment,
  documentsDocument,
} from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { DOCUMENT_EXPIRY_SOON_DAYS } from '@/lib/constants';
import type { CreditStatus, PaymentStatus } from '@/lib/db/schema';

export type ActiveCreditCard = {
  id: number;
  name: string;
  bankName: string;
  amount: string;
  status: CreditStatus;
  startDate: string;
  termMonths: number;
  paidAmount: string;
  remainingAmount: string;
  paymentsTotal: number;
  paymentsPaid: number;
  paymentsOverdue: number;
  nextPayment: { id: number; dueDate: string; amount: string; status: PaymentStatus } | null;
};

export type UpcomingPayment = {
  id: number;
  creditId: number;
  creditName: string;
  bankName: string;
  amount: string;
  dueDate: string;
  status: PaymentStatus;
};

export type ExpiringDocument = {
  id: number;
  title: string;
  documentType: string;
  expiryDate: string;
};

export type DashboardData = {
  creditsByStatus: { total: number; active: number; overdue: number; closed: number };
  payments: {
    total: number;
    scheduled: number;
    overdue: number;
    paid: number;
    paidAmount: string;
    remainingAmount: string;
  };
  activeCredits: ActiveCreditCard[];
  upcomingPayments: UpcomingPayment[];
  expiringDocuments: ExpiringDocument[];
  perBank: { bankName: string; remaining: string }[];
};

export async function getDashboard(user: SessionUser): Promise<DashboardData> {
  const own = ownership(user, creditsCredit.userId);

  const [creditsByStatus] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      active: sql<number>`COUNT(*) FILTER (WHERE ${creditsCredit.status} = 'active')::int`,
      overdue: sql<number>`COUNT(*) FILTER (WHERE ${creditsCredit.status} = 'overdue')::int`,
      closed: sql<number>`COUNT(*) FILTER (WHERE ${creditsCredit.status} = 'closed')::int`,
    })
    .from(creditsCredit)
    .where(own);

  const [payments] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      scheduled: sql<number>`COUNT(*) FILTER (WHERE ${creditsPayment.status} = 'scheduled')::int`,
      overdue: sql<number>`COUNT(*) FILTER (WHERE ${creditsPayment.status} = 'overdue')::int`,
      paid: sql<number>`COUNT(*) FILTER (WHERE ${creditsPayment.status} = 'paid')::int`,
      paidAmount: sql<string>`COALESCE(SUM(${creditsPayment.amount}) FILTER (WHERE ${creditsPayment.status} = 'paid'), 0)::text`,
      remainingAmount: sql<string>`COALESCE(SUM(${creditsPayment.amount}) FILTER (WHERE ${creditsPayment.status} IN ('scheduled','overdue')), 0)::text`,
    })
    .from(creditsPayment)
    .innerJoin(creditsCredit, eq(creditsCredit.id, creditsPayment.creditId))
    .where(own);

  // Активные (не закрытые) кредиты + агрегаты по платежам.
  const creditRows = await db
    .select({
      id: creditsCredit.id,
      rawName: creditsCredit.name,
      bankName: creditsBank.name,
      amount: creditsCredit.amount,
      status: creditsCredit.status,
      startDate: creditsCredit.startDate,
      termMonths: creditsCredit.termMonths,
      paidAmount: sql<string>`COALESCE(SUM(${creditsPayment.amount}) FILTER (WHERE ${creditsPayment.status} = 'paid'), 0)::text`,
      remainingAmount: sql<string>`COALESCE(SUM(${creditsPayment.amount}) FILTER (WHERE ${creditsPayment.status} IN ('scheduled','overdue')), 0)::text`,
      paymentsTotal: sql<number>`COUNT(${creditsPayment.id})::int`,
      paymentsPaid: sql<number>`COUNT(${creditsPayment.id}) FILTER (WHERE ${creditsPayment.status} = 'paid')::int`,
      paymentsOverdue: sql<number>`COUNT(${creditsPayment.id}) FILTER (WHERE ${creditsPayment.status} = 'overdue')::int`,
    })
    .from(creditsCredit)
    .innerJoin(creditsBank, eq(creditsBank.id, creditsCredit.bankId))
    .leftJoin(creditsPayment, eq(creditsPayment.creditId, creditsCredit.id))
    .where(and(ne(creditsCredit.status, 'closed'), own))
    .groupBy(creditsCredit.id, creditsBank.name)
    .orderBy(desc(creditsCredit.startDate), desc(creditsCredit.id));

  const creditIds = creditRows.map((c) => c.id);

  // Ближайший неоплаченный платёж по каждому кредиту.
  const nextByCredit = new Map<number, ActiveCreditCard['nextPayment']>();
  if (creditIds.length > 0) {
    const nextRows = await db
      .select({
        id: creditsPayment.id,
        creditId: creditsPayment.creditId,
        dueDate: creditsPayment.dueDate,
        amount: creditsPayment.amount,
        status: creditsPayment.status,
      })
      .from(creditsPayment)
      .where(
        and(
          inArray(creditsPayment.creditId, creditIds),
          inArray(creditsPayment.status, ['scheduled', 'overdue']),
        ),
      )
      .orderBy(asc(creditsPayment.dueDate), asc(creditsPayment.id));
    for (const row of nextRows) {
      if (!nextByCredit.has(row.creditId)) {
        nextByCredit.set(row.creditId, {
          id: row.id,
          dueDate: row.dueDate,
          amount: row.amount,
          status: row.status,
        });
      }
    }
  }

  const activeCredits: ActiveCreditCard[] = creditRows.map((c) => ({
    id: c.id,
    name: c.rawName?.trim() ? c.rawName : c.bankName,
    bankName: c.bankName,
    amount: c.amount,
    status: c.status,
    startDate: c.startDate,
    termMonths: c.termMonths,
    paidAmount: c.paidAmount,
    remainingAmount: c.remainingAmount,
    paymentsTotal: c.paymentsTotal,
    paymentsPaid: c.paymentsPaid,
    paymentsOverdue: c.paymentsOverdue,
    nextPayment: nextByCredit.get(c.id) ?? null,
  }));

  // Платежи в ближайшие 30 дней.
  const upcomingRows = await db
    .select({
      id: creditsPayment.id,
      creditId: creditsPayment.creditId,
      rawCreditName: creditsCredit.name,
      bankName: creditsBank.name,
      amount: creditsPayment.amount,
      dueDate: creditsPayment.dueDate,
      status: creditsPayment.status,
    })
    .from(creditsPayment)
    .innerJoin(creditsCredit, eq(creditsCredit.id, creditsPayment.creditId))
    .innerJoin(creditsBank, eq(creditsBank.id, creditsCredit.bankId))
    .where(
      and(
        inArray(creditsPayment.status, ['scheduled', 'overdue']),
        sql`${creditsPayment.dueDate} <= (CURRENT_DATE + INTERVAL '30 days')`,
        own,
      ),
    )
    .orderBy(asc(creditsPayment.dueDate), asc(creditsPayment.id))
    .limit(30);

  const upcomingPayments: UpcomingPayment[] = upcomingRows.map(({ rawCreditName, ...r }) => ({
    ...r,
    creditName: rawCreditName?.trim() ? rawCreditName : r.bankName,
  }));

  // Документы с истекающим (или истёкшим) сроком действия.
  const expiringDocuments: ExpiringDocument[] = await db
    .select({
      id: documentsDocument.id,
      title: documentsDocument.title,
      documentType: documentsDocument.documentType,
      expiryDate: sql<string>`${documentsDocument.expiryDate}`,
    })
    .from(documentsDocument)
    .where(
      and(
        ownership(user, documentsDocument.userId),
        eq(documentsDocument.isActive, true),
        sql`${documentsDocument.expiryDate} IS NOT NULL`,
        sql`${documentsDocument.expiryDate} <= (CURRENT_DATE + make_interval(days => ${DOCUMENT_EXPIRY_SOON_DAYS}))`,
      ),
    )
    .orderBy(asc(documentsDocument.expiryDate), asc(documentsDocument.id))
    .limit(30);

  // Экспозиция по банкам (остаток к погашению).
  const perBank = await db
    .select({
      bankName: creditsBank.name,
      remaining: sql<string>`COALESCE(SUM(${creditsPayment.amount}) FILTER (WHERE ${creditsPayment.status} IN ('scheduled','overdue')), 0)::text`,
    })
    .from(creditsCredit)
    .innerJoin(creditsBank, eq(creditsBank.id, creditsCredit.bankId))
    .leftJoin(creditsPayment, eq(creditsPayment.creditId, creditsCredit.id))
    .where(own)
    .groupBy(creditsBank.name)
    .orderBy(asc(creditsBank.name));

  return {
    creditsByStatus: creditsByStatus ?? { total: 0, active: 0, overdue: 0, closed: 0 },
    payments: payments ?? {
      total: 0,
      scheduled: 0,
      overdue: 0,
      paid: 0,
      paidAmount: '0',
      remainingAmount: '0',
    },
    activeCredits,
    upcomingPayments,
    expiringDocuments,
    perBank: perBank.filter((b) => Number(b.remaining) > 0),
  };
}
