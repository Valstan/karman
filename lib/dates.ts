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

function parseUtcMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Целое число дней между двумя `YYYY-MM-DD` (toStr − fromStr), без таймзонных сдвигов. */
export function daysBetween(fromStr: string, toStr: string): number {
  return Math.round((parseUtcMs(toStr) - parseUtcMs(fromStr)) / 86_400_000);
}

/** Сколько дней осталось до `dateStr` от сегодня (отрицательное — дата в прошлом). */
export function daysUntil(dateStr: string, today: string = todayStr()): number {
  return daysBetween(today, dateStr);
}
