import type { CreditStatus, PaymentStatus, PaymentType } from '@/lib/db/schema';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export const CREDIT_STATUS_LABELS: Record<CreditStatus, string> = {
  active: 'Активен',
  overdue: 'Просрочен',
  closed: 'Закрыт',
};

export const CREDIT_STATUS_VARIANT: Record<CreditStatus, BadgeVariant> = {
  active: 'default',
  overdue: 'destructive',
  closed: 'secondary',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  scheduled: 'Запланирован',
  overdue: 'Просрочен',
  paid: 'Оплачен',
};

export const PAYMENT_STATUS_VARIANT: Record<PaymentStatus, BadgeVariant> = {
  scheduled: 'secondary',
  overdue: 'destructive',
  paid: 'default',
};

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  annuity: 'Аннуитетный',
  differentiated: 'Дифференцированный',
  other: 'Другой',
};

export function creditStatusLabel(status: string): string {
  return CREDIT_STATUS_LABELS[status as CreditStatus] ?? status;
}

export function creditStatusVariant(status: string): BadgeVariant {
  return CREDIT_STATUS_VARIANT[status as CreditStatus] ?? 'outline';
}

export function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[status as PaymentStatus] ?? status;
}

export function paymentStatusVariant(status: string): BadgeVariant {
  return PAYMENT_STATUS_VARIANT[status as PaymentStatus] ?? 'outline';
}

export function paymentTypeLabel(type: string): string {
  return PAYMENT_TYPE_LABELS[type as PaymentType] ?? type;
}
