/**
 * Простой in-memory rate-limit (fixed window) для эндпоинта секретов. Защита от
 * злоупотребления, не криптографическая (токены высокоэнтропийны, перебор не грозит).
 * Per-instance: на проде единственный инстанс standalone — достаточно. При горизонтальном
 * масштабировании заменить на общий стор (Redis). Date.now() — рантайм-время сервера.
 *
 * ## Уборка просроченного (аудит #057, D3)
 *
 * Ключи строятся из IP и из первых символов Bearer, поэтому анонимный трафик создавал
 * запись на каждый запрос, а удалялась запись только при попадании в тот же ключ. На
 * `MemoryMax=512M` это путь к рестарт-лупу. Теперь окно истёкшие ключи вычищаются, а при
 * переполнении карта сбрасывается целиком.
 */

type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const MAX_BUCKETS = 20_000;
const buckets = new Map<string, Bucket>();

function sweep(now: number): void {
  if (buckets.size <= MAX_BUCKETS) {
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
    return;
  }
  buckets.clear();
}

/** true — запрос разрешён; false — лимит исчерпан в текущем окне. */
export function rateLimit(key: string, now: number = Date.now()): boolean {
  sweep(now);
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (b.count >= MAX_PER_WINDOW) return false;
  b.count += 1;
  return true;
}
