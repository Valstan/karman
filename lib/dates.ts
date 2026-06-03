/**
 * Операции над датами-строками `YYYY-MM-DD` без таймзонных конверсий
 * (никаких new Date().toISOString() — чтобы не ловить off-by-one).
 */

function daysInMonth(year: number, monthIndex: number): number {
  // monthIndex: 0..11
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const monthIndex = ((total % 12) + 12) % 12;
  const day = Math.min(d, daysInMonth(year, monthIndex));
  const mm = String(monthIndex + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export function todayStr(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}
