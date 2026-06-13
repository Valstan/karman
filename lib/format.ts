const moneyFormatter = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const n = Number(value);
  return Number.isFinite(n) ? moneyFormatter.format(n) : '—';
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY' (без таймзонных конверсий). */
export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const [y, m, d] = value.split('-');
  if (!y || !m || !d) {
    return value;
  }
  return `${d}.${m}.${y}`;
}

export function formatPercent(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const n = Number(value);
  return Number.isFinite(n) ? `${numberFormatter.format(n)}%` : '—';
}
