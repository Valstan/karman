export type AuthUser = {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  is_superuser: boolean;
};

export type BankRow = {
  id: number;
  name: string;
  website: string | null;
  address: string | null;
  phone: string | null;
  email?: string | null;
};

export type CreditStatus = 'active' | 'overdue' | 'closed' | string;

export type CreditRow = {
  id: number;
  name: string;
  raw_name: string;
  bank_id: number;
  bank_name: string;
  bank_website: string | null;
  amount: string;
  interest_rate: string;
  monthly_payment: string | null;
  payment_type: string;
  start_date: string;
  status: CreditStatus;
  term_months: number;
  description: string | null;
};

export type PaymentStatus = 'scheduled' | 'overdue' | 'paid' | string;

export type PaymentRow = {
  id: number;
  credit_id: number;
  credit_name?: string;
  bank_name?: string;
  amount: string;
  principal_amount: string | null;
  interest_amount: string | null;
  due_date: string;
  paid_date: string | null;
  status: PaymentStatus;
};

export type DocumentRow = {
  id: number;
  title: string;
  document_type: string;
  document_number: string;
  issue_date: string | null;
  expiry_date: string | null;
  issuing_authority: string | null;
  is_active: boolean;
};

export type CreditAggregates = {
  paid_amount: string;
  remaining_amount: string;
  payments_total: number;
  payments_paid: number;
  payments_scheduled: number;
  payments_overdue: number;
};

export type CreditDetail = CreditRow & {
  aggregates: CreditAggregates;
  payments: PaymentRow[];
};

export type NextPayment = {
  id: number;
  due_date: string;
  amount: string;
  status: PaymentStatus;
};

export type ActiveCreditCard = {
  id: number;
  name: string;
  bank_name: string;
  amount: string;
  status: CreditStatus;
  start_date: string;
  term_months: number;
  paid_amount: string;
  remaining_amount: string;
  payments_total: number;
  payments_paid: number;
  payments_overdue: number;
  next_payment: NextPayment | null;
};

export type UpcomingPayment = {
  id: number;
  credit_id: number;
  credit_name: string;
  bank_name: string;
  amount: string;
  due_date: string;
  status: PaymentStatus;
};

export type DashboardSummary = {
  credits: {
    total: number;
    active: number;
    overdue: number;
    closed: number;
  };
  payments: {
    total: number;
    scheduled: number;
    overdue: number;
    paid: number;
    paid_amount: string;
    remaining_amount: string;
  };
  active_credits: ActiveCreditCard[];
  upcoming_payments: UpcomingPayment[];
};

export type CreditFormValues = {
  name: string;
  bank_id: number;
  amount: string;
  interest_rate: string;
  monthly_payment?: string;
  start_date: string;
  term_months: string;
  status: string;
  payment_type: string;
  description?: string;
};

export type PaymentFormValues = {
  amount: string;
  principal_amount?: string;
  interest_amount?: string;
  due_date: string;
  paid_date?: string;
  status: PaymentStatus;
};
