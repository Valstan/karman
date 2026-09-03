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

/**
 * 'YYYY-MM-DD' → 'DD.MM.YYYY' (без таймзонных конверсий).
 *
 * Только для колонок типа `date`. Метке времени (`timestamptz`) этот формат
 * не подходит: `split('-')` отдаёт день вместе с хвостом, и строка
 * `2026-09-03 05:44:50+00` печатается как `03 05:44:50+00.09.2026`.
 * Для меток времени — `formatDateTime` ниже.
 */
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

/**
 * Метка времени → 'DD.MM.YYYY ЧЧ:ММ' в местном времени браузера/сервера.
 *
 * Принимает и `2026-09-03 05:44:50.19+00` (так timestamptz приезжает из
 * Postgres в режиме `mode: 'string'`), и ISO с `T`. Время здесь не украшение:
 * времянка живёт 30 минут, а сессия паспорта — час, и одна дата про них
 * не отвечает ни на один вопрос.
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const d = new Date(toIso(value));
  if (Number.isNaN(d.getTime())) {
    return value;
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Приводит метку времени Postgres к строке, которую разбирает `Date`.
 *
 * Три отличия, и каждое поодиночке даёт Invalid Date, а не сдвиг:
 * пробел вместо `T`; смещение `+00` без минут (ISO требует `+00:00`);
 * микросекунды — шесть знаков после запятой вместо трёх.
 */
function toIso(value: string): string {
  return value
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
}

export function formatPercent(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const n = Number(value);
  return Number.isFinite(n) ? `${numberFormatter.format(n)}%` : '—';
}
