/**
 * Простой in-memory rate-limit (fixed window) для эндпоинта секретов. Защита от
 * злоупотребления, не криптографическая (токены высокоэнтропийны, перебор не грозит).
 * Per-instance: на Боксе 1 один инстанс standalone — достаточно. При горизонтальном
 * масштабировании заменить на общий стор (Redis). Date.now() — рантайм-время сервера.
 */

type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const buckets = new Map<string, Bucket>();

/** true — запрос разрешён; false — лимит исчерпан в текущем окне. */
export function rateLimit(key: string, now: number = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (b.count >= MAX_PER_WINDOW) return false;
  b.count += 1;
  return true;
}
