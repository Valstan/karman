/**
 * Денежная арифметика в копейках (целые числа) — никаких float-дрейфов.
 * На входе/выходе деньги — строки `"123.45"` (конвенция numeric → string).
 */

export function toKopecks(value: string | number): number {
  if (typeof value === 'number') {
    return Math.round(value * 100);
  }
  const normalized = value.trim().replace(',', '.');
  const negative = normalized.startsWith('-');
  const abs = negative ? normalized.slice(1) : normalized;
  const [whole, frac = ''] = abs.split('.');
  const fracPadded = (frac + '00').slice(0, 2);
  const kopecks = Number(whole) * 100 + Number(fracPadded);
  return negative ? -kopecks : kopecks;
}

export function fromKopecks(kopecks: number): string {
  const negative = kopecks < 0;
  const abs = Math.abs(Math.round(kopecks));
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
