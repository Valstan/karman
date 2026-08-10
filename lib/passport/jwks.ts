import 'server-only';
import { eq } from 'drizzle-orm';
import type { JSONWebKeySet } from 'jose';
import { db } from '@/lib/db/client';
import { passportJwksCache } from '@/lib/db/schema';

/**
 * Снимок JWKS доверенного issuer'а: удалённый фетч + cooldown + stale-if-error
 * (форма выбрана после probe с Бокса 1 — удалённый JWKS достижим, 200/0.45 с).
 *
 * Почему не `createRemoteJWKSet` из jose: он держит кеш в памяти процесса, то
 * есть переживает не больше рестарта, и при недоступности issuer'а падает.
 * Здесь снимок лежит в БД — проверка подписи продолжает работать, пока ключи не
 * ротировались, даже если чужой CDN лежит или бокс временно без внешней сети.
 *
 * Граница ответственности: этот модуль отвечает за «какие ключи», проверка
 * подписи — в чистом `verify.ts`.
 */

/** Не ходить в сеть чаще этого срока, если снимок свежий (cooldown). */
const REFRESH_AFTER_MS = 15 * 60_000;
/** Сколько ждать issuer'а. Дольше — клиент CI получает таймаут вместо ответа. */
const FETCH_TIMEOUT_MS = 5_000;

function isJwks(value: unknown): value is JSONWebKeySet {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { keys?: unknown }).keys) &&
    (value as { keys: unknown[] }).keys.length > 0
  );
}

async function fetchJwks(jwksUri: string): Promise<JSONWebKeySet> {
  const res = await fetch(jwksUri, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isJwks(body)) throw new Error('ответ не похож на JWKS');
  return body;
}

export type JwksSnapshot = {
  jwks: JSONWebKeySet;
  /** true — снимок отдан из кеша после неудачного обновления (stale-if-error). */
  stale: boolean;
  fetchedAt: Date;
};

/**
 * Ключи issuer'а: свежий снимок, а при недоступности — последний удачный.
 * null только если ключей нет ВООБЩЕ (первый фетч не удался) — тогда выше
 * по стеку отказ, а не «пропустить проверку подписи».
 */
export async function getJwks(jwksUri: string, now: Date = new Date()): Promise<JwksSnapshot | null> {
  const [cached] = await db
    .select()
    .from(passportJwksCache)
    .where(eq(passportJwksCache.jwksUri, jwksUri))
    .limit(1);

  const fetchedAt = cached ? new Date(cached.fetchedAt) : null;
  const fresh = fetchedAt !== null && now.getTime() - fetchedAt.getTime() < REFRESH_AFTER_MS;
  if (cached && fresh && isJwks(cached.jwks)) {
    return { jwks: cached.jwks, stale: false, fetchedAt };
  }

  try {
    const jwks = await fetchJwks(jwksUri);
    await db
      .insert(passportJwksCache)
      .values({ jwksUri, jwks, fetchedAt: now.toISOString() })
      .onConflictDoUpdate({
        target: passportJwksCache.jwksUri,
        // Ошибку гасим: снимок снова актуален, и старая запись об ошибке
        // иначе висела бы вечно, изображая проблему.
        set: { jwks, fetchedAt: now.toISOString(), lastError: null, lastErrorAt: null },
      });
    return { jwks, stale: false, fetchedAt: now };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'ошибка запроса JWKS';
    if (cached) {
      await db
        .update(passportJwksCache)
        .set({ lastError: message, lastErrorAt: now.toISOString() })
        .where(eq(passportJwksCache.jwksUri, jwksUri));
      // stale-if-error: ключи ротируются редко, а отказ в выдаче сессии из-за
      // чужого CDN — отказ в обслуживании собственным проектам.
      if (isJwks(cached.jwks) && fetchedAt) {
        return { jwks: cached.jwks, stale: true, fetchedAt };
      }
    }
    return null;
  }
}
