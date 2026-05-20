export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }
  return numeric.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString('ru-RU');
}

export function formatPercent(numerator: string | number, denominator: string | number): string {
  const a = typeof numerator === 'number' ? numerator : Number(numerator);
  const b = typeof denominator === 'number' ? denominator : Number(denominator);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return '0';
  }
  return ((a / b) * 100).toFixed(0);
}

export function progressPercent(paid: string | number, total: string | number): number {
  const a = typeof paid === 'number' ? paid : Number(paid);
  const b = typeof total === 'number' ? total : Number(total);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (a / b) * 100));
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysUntil(dateString: string | null | undefined): number | null {
  if (!dateString) {
    return null;
  }
  const target = new Date(dateString);
  if (Number.isNaN(target.getTime())) {
    return null;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  const diffMs = target.getTime() - today.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}
