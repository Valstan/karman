/**
 * Проверка ЗНАЧЕНИЯ SESSION_SECRET, а не только его наличия (S1, аудит #057 от 03.10).
 *
 * До 02.11 код проверял только НАЛИЧИЕ переменной: `SESSION_SECRET=change-me-in-production`
 * принимался, и прод на таком плейсхолдере тихо работал — подписывая сессии ключом,
 * который напечатан в README и в шаблоне systemd-юнита. То есть «секрета не было»
 * не было: был известный всем ключ.
 *
 * Правило живёт здесь, а не в instrumentation.ts, потому что его должны видеть
 * ДВА места: ранний отказ на старте сервера (instrumentation) и ленивое чтение
 * ключа при подписи (jwt.ts). Правило одно — иначе «отказ при старте» и «отказ
 * при первом запросе» разойдутся.
 *
 * Границы:
 * - Только production. В dev работает осознанный dev-fallback (см. jwt.ts).
 * - Значение НЕ попадает в текст ошибки: иначе fail-fast сам станет утечкой.
 */

/** Минимальная длина: боевой секрет — `openssl rand -base64 48` (64 символа). */
export const SESSION_SECRET_MIN_LENGTH = 32;

/**
 * Маркеры плейсхолдеров из шаблонов (README, systemd-юнит, .env.example).
 * Сравнение регистронезависимое и по ВХОЖДЕНИЮ, а не по равенству: шаблон
 * меняют как `change-me-in-production` → `change-me-before-prod`, и проверка
 * на точное равенство тогда бы молча перестала ловить.
 */
const PLACEHOLDER_MARKERS = ['change-me', 'insecure-secret'];

/**
 * Что не так с секретом; `null` — секрет годится. Сообщение не содержит
 * самого значения.
 */
export function sessionSecretProblem(secret: string | undefined): string | null {
  if (secret === undefined || secret.trim() === '') return 'SESSION_SECRET не задан';
  const value = secret.trim();
  const lower = value.toLowerCase();
  for (const marker of PLACEHOLDER_MARKERS) {
    if (lower.includes(marker)) return `SESSION_SECRET — плейсхолдер (${marker})`;
  }
  if (value.length < SESSION_SECRET_MIN_LENGTH) {
    return `SESSION_SECRET короче ${SESSION_SECRET_MIN_LENGTH} символов (${value.length})`;
  }
  return null;
}

/** Бросить с понятной причиной, если секрет не годится. */
export function assertSessionSecret(secret: string | undefined): void {
  const problem = sessionSecretProblem(secret);
  if (problem !== null) {
    throw new Error(`${problem} — в production сервис на таком секрете не стартует`);
  }
}
