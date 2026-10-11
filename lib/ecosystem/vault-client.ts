/**
 * Собакоедение vault-client (S1 дорожной карты доступов, D-119).
 *
 * Тот же HTTP-контракт, что и у соседей (`docs/secrets-client-guide.md`):
 * GET/POST `$VAULT_URL/api/secrets` под Bearer-токеном комнаты. КАРМАН
 * читает СВОИ секреты из своего vault тем же клиентом, а не «внутренним»
 * путём — контракт становится общим, а его шероховатости (G331: промах
 * ключа — громкий 404 с `missing`) ловятся на собственном примере.
 */

export type VaultClient = {
  /** Все секреты комнаты; пустая комната — `{}` молча (допустимо без перечня). */
  loadAll(): Promise<Record<string, string>>;
  /**
   * Секреты по перечню ключей; промах любого — HTTP 404 с `missing`
   * (G331: bootstrap всегда ходит с перечнем ожидаемого).
   */
  loadExpect(keys: readonly string[]): Promise<Record<string, string>>;
  /** Bulk upsert; возвращает число записанных. Нужен токен с правом записи. */
  save(secrets: Record<string, string>): Promise<number>;
};

export class VaultHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`vault API ${status}: ${body}`);
    this.name = 'VaultHttpError';
  }
}

async function parseSecrets(res: Response): Promise<Record<string, string>> {
  const json = (await res.json()) as { secrets?: Record<string, string> };
  return json.secrets ?? {};
}

/**
 * Клиент по env: `VAULT_URL` (базовый адрес vault) + `SECRETS_TOKEN`
 * (токен комнаты). null — vault не подключён (обёртка выше решает,
 * жить ли на env-фолбэке).
 */
export function vaultClientFromEnv(): VaultClient | null {
  const baseUrl = process.env.VAULT_URL?.trim();
  const token = process.env.SECRETS_TOKEN?.trim();
  if (!baseUrl || !token) return null;

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/secrets`;
  const auth = { Authorization: `Bearer ${token}` };

  const loadAll = async (): Promise<Record<string, string>> => {
    const res = await fetch(endpoint, { headers: auth });
    if (!res.ok) throw new VaultHttpError(res.status, await res.text());
    return parseSecrets(res);
  };

  const loadExpect = async (
    keys: readonly string[],
  ): Promise<Record<string, string>> => {
    if (keys.length === 0) return loadAll();
    const url = `${endpoint}?key=${keys.map(encodeURIComponent).join(',')}`;
    const res = await fetch(url, { headers: auth });
    if (!res.ok) throw new VaultHttpError(res.status, await res.text());
    return parseSecrets(res);
  };

  const save = async (secrets: Record<string, string>): Promise<number> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ secrets }),
    });
    if (!res.ok) throw new VaultHttpError(res.status, await res.text());
    const json = (await res.json()) as { written?: number };
    return json.written ?? 0;
  };

  return { loadAll, loadExpect, save };
}
