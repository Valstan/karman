import { vaultClientFromEnv } from '@/lib/ecosystem/vault-client';

/**
 * Восстановление рантайм-секретов при старте из vault (S1, D-119).
 *
 * Значение живёт в vault-комнате (у сервиса — своя); env — только
 * фолбэк на случай, пока vault не поднялся. Восстановление ленивое:
 * при первом обращении (self-fetch в instrumentation упирается в
 * порядок биндиния порта — к моменту первого запроса сервер гарантированно
 * поднят), далее кэш обновляется по TTL: ротация перекрытием
 * «выпустить новый → проверить → отозвать старый» подхватывается
 * без перезапуска.
 *
 * Stale-while-revalidate: vault недоступен — отдаём последний известный
 * кэш, relay не роняем. Fail-closed сохраняется: секрет нигде не
 * найден — null, и роут отвечает 503 (как «не настроено»).
 */

const REFRESH_TTL_MS = 10 * 60_000;

type Entry = { value: string; cachedAt: number };

let cache = new Map<string, Entry>();
let inflight: Promise<void> | null = null;

/** Сброс кэша — только для тестов. */
export function resetRuntimeSecrets(): void {
  cache = new Map();
  inflight = null;
}

async function refresh(): Promise<void> {
  const client = vaultClientFromEnv();
  if (!client) return; // vault не подключён — живём на env
  const loaded = await client.loadAll();
  const now = Date.now();
  cache = new Map(
    Object.entries(loaded).map(([key, value]) => [key, { value, cachedAt: now }]),
  );
}

/**
 * Секрет по ключу: свежий кэш → (по TTL) vault → стоп-кэш → env.
 * null — нигде не найден.
 */
export async function runtimeSecret(key: string): Promise<string | null> {
  const hit = cache.get(key);
  const fresh = hit !== undefined && Date.now() - hit.cachedAt < REFRESH_TTL_MS;
  if (!fresh && !inflight) {
    inflight = refresh().finally(() => {
      inflight = null;
    });
  }
  if (inflight) {
    try {
      await inflight;
    } catch {
      // vault недоступен — ниже: стоп-кэш, потом env
    }
  }
  const after = cache.get(key);
  if (after) return after.value;
  const env = process.env[key];
  return env && env !== '' ? env : null;
}
