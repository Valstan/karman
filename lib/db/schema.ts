/**
 * Drizzle-схема, отражающая СУЩЕСТВУЮЩИЕ таблицы БД `karman_db`,
 * изначально созданные Django. Имена таблиц и колонок — snake_case, как в БД.
 *
 * ВАЖНО: перед прод-деплоем сверить эту схему с реальной БД через
 * `drizzle-kit pull` на клоне/дампе (см. план, раздел «Слой данных»).
 * Денежные колонки объявлены как numeric БЕЗ mode:'number' — Drizzle
 * возвращает их строками (сохраняем конвенцию `::text`, избегаем float-дрейфа).
 */
import {
  boolean,
  date,
  integer,
  numeric,
  pgTable,
  serial,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export type CreditStatus = 'active' | 'overdue' | 'closed';
export type PaymentStatus = 'scheduled' | 'overdue' | 'paid';
export type PaymentType = 'annuity' | 'differentiated' | 'other';

// --- Пользователи (Django auth_user) ---------------------------------------
export const authUser = pgTable('auth_user', {
  id: serial('id').primaryKey(),
  password: varchar('password', { length: 128 }).notNull(),
  lastLogin: timestamp('last_login', { withTimezone: true, mode: 'string' }),
  isSuperuser: boolean('is_superuser').notNull().default(false),
  username: varchar('username', { length: 150 }).notNull(),
  firstName: varchar('first_name', { length: 150 }).notNull().default(''),
  lastName: varchar('last_name', { length: 150 }).notNull().default(''),
  email: varchar('email', { length: 254 }).notNull().default(''),
  isStaff: boolean('is_staff').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  dateJoined: timestamp('date_joined', { withTimezone: true, mode: 'string' }),
});

// --- Банки / МФО (общий справочник, без user_id) ---------------------------
export const creditsBank = pgTable('credits_bank', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  address: varchar('address', { length: 500 }),
  phone: varchar('phone', { length: 50 }),
  email: varchar('email', { length: 254 }),
  website: varchar('website', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
});

// --- Кредиты ----------------------------------------------------------------
export const creditsCredit = pgTable('credits_credit', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull().default(''),
  description: varchar('description', { length: 2000 }),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  interestRate: numeric('interest_rate', { precision: 6, scale: 2 }).notNull(),
  monthlyPayment: numeric('monthly_payment', { precision: 14, scale: 2 }),
  paymentType: varchar('payment_type', { length: 20 })
    .$type<PaymentType>()
    .notNull()
    .default('annuity'),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  status: varchar('status', { length: 20 }).$type<CreditStatus>().notNull().default('active'),
  termMonths: integer('term_months').notNull(),
  bankId: integer('bank_id')
    .notNull()
    .references(() => creditsBank.id),
  userId: integer('user_id')
    .notNull()
    .references(() => authUser.id),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

// --- Платежи по кредитам ----------------------------------------------------
export const creditsPayment = pgTable('credits_payment', {
  id: serial('id').primaryKey(),
  creditId: integer('credit_id')
    .notNull()
    .references(() => creditsCredit.id, { onDelete: 'cascade' }),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  principalAmount: numeric('principal_amount', { precision: 14, scale: 2 }),
  interestAmount: numeric('interest_amount', { precision: 14, scale: 2 }),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  paidDate: date('paid_date', { mode: 'string' }),
  status: varchar('status', { length: 20 }).$type<PaymentStatus>().notNull().default('scheduled'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
});

// --- Документы пользователя -------------------------------------------------
export const documentsDocument = pgTable('documents_document', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  documentType: varchar('document_type', { length: 50 }).notNull().default(''),
  documentNumber: varchar('document_number', { length: 100 }).notNull().default(''),
  issueDate: date('issue_date', { mode: 'string' }),
  expiryDate: date('expiry_date', { mode: 'string' }),
  issuingAuthority: varchar('issuing_authority', { length: 255 }),
  isActive: boolean('is_active').notNull().default(true),
  userId: integer('user_id')
    .notNull()
    .references(() => authUser.id),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
});

// --- Связи ------------------------------------------------------------------
export const creditsBankRelations = relations(creditsBank, ({ many }) => ({
  credits: many(creditsCredit),
}));

export const creditsCreditRelations = relations(creditsCredit, ({ one, many }) => ({
  bank: one(creditsBank, { fields: [creditsCredit.bankId], references: [creditsBank.id] }),
  user: one(authUser, { fields: [creditsCredit.userId], references: [authUser.id] }),
  payments: many(creditsPayment),
}));

export const creditsPaymentRelations = relations(creditsPayment, ({ one }) => ({
  credit: one(creditsCredit, {
    fields: [creditsPayment.creditId],
    references: [creditsCredit.id],
  }),
}));

export const documentsDocumentRelations = relations(documentsDocument, ({ one }) => ({
  user: one(authUser, { fields: [documentsDocument.userId], references: [authUser.id] }),
}));

export type AuthUserRow = typeof authUser.$inferSelect;
export type BankRow = typeof creditsBank.$inferSelect;
export type CreditRow = typeof creditsCredit.$inferSelect;
export type PaymentRow = typeof creditsPayment.$inferSelect;
export type DocumentRow = typeof documentsDocument.$inferSelect;
