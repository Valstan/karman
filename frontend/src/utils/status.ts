import type { CreditStatus, PaymentStatus } from '../types';

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  scheduled: 'Запланирован',
  overdue: 'Просрочен',
  paid: 'Оплачен',
};

export const CREDIT_STATUS_LABELS: Record<string, string> = {
  active: 'Активный',
  overdue: 'Просрочен',
  closed: 'Закрыт',
};

export const PAYMENT_STATUS_OPTIONS = [
  { value: 'scheduled', label: 'Запланирован' },
  { value: 'overdue', label: 'Просрочен' },
  { value: 'paid', label: 'Оплачен' },
];

export const CREDIT_STATUS_OPTIONS = [
  { value: 'active', label: 'Активный' },
  { value: 'overdue', label: 'Просрочен' },
  { value: 'closed', label: 'Закрыт' },
];

export const PAYMENT_TYPE_OPTIONS = [
  { value: 'annuity', label: 'Аннуитетный' },
  { value: 'differentiated', label: 'Дифференцированный' },
  { value: 'other', label: 'Другой' },
];

export function paymentStatusColor(status: PaymentStatus): string {
  switch (status) {
    case 'paid':
      return 'green';
    case 'overdue':
      return 'red';
    case 'scheduled':
      return 'blue';
    default:
      return 'default';
  }
}

export function creditStatusColor(status: CreditStatus): string {
  switch (status) {
    case 'active':
      return 'green';
    case 'overdue':
      return 'red';
    case 'closed':
      return 'default';
    default:
      return 'default';
  }
}

export function paymentRowColorByDate(daysUntilDue: number | null, status: PaymentStatus): string | undefined {
  if (status === 'paid') {
    return undefined;
  }
  if (status === 'overdue' || (daysUntilDue !== null && daysUntilDue < 0)) {
    return 'rgba(255, 77, 79, 0.08)';
  }
  if (daysUntilDue !== null && daysUntilDue <= 7) {
    return 'rgba(250, 173, 20, 0.08)';
  }
  return undefined;
}
