import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeSecrets, runtimeSecret } from '@/lib/ecosystem/runtime-secrets';

const saved = {
  VAULT_URL: process.env.VAULT_URL,
  SECRETS_TOKEN: process.env.SECRETS_TOKEN,
  HOTLINE_RELAY_SECRET: process.env.HOTLINE_RELAY_SECRET,
};

beforeEach(() => {
  delete process.env.VAULT_URL;
  delete process.env.SECRETS_TOKEN;
  delete process.env.HOTLINE_RELAY_SECRET;
  resetRuntimeSecrets();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRuntimeSecrets();
  vi.useRealTimers();
  if (saved.VAULT_URL === undefined) delete process.env.VAULT_URL;
  else process.env.VAULT_URL = saved.VAULT_URL;
  if (saved.SECRETS_TOKEN === undefined) delete process.env.SECRETS_TOKEN;
  else process.env.SECRETS_TOKEN = saved.SECRETS_TOKEN;
  if (saved.HOTLINE_RELAY_SECRET === undefined) delete process.env.HOTLINE_RELAY_SECRET;
  else process.env.HOTLINE_RELAY_SECRET = saved.HOTLINE_RELAY_SECRET;
});

function envVaultOn() {
  process.env.VAULT_URL = 'https://vault.example';
  process.env.SECRETS_TOKEN = 'skm_test-token';
}

describe('runtimeSecret: восстановление из vault при старте', () => {
  it('vault-first: значение живёт в vault, env не нужен', async () => {
    envVaultOn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({ secrets: { HOTLINE_RELAY_SECRET: 'from-vault' } }),
      ),
    );
    expect(await runtimeSecret('HOTLINE_RELAY_SECRET')).toBe('from-vault');
  });

  it('env-фолбэк: vault не подключён — живём на env', async () => {
    process.env.HOTLINE_RELAY_SECRET = 'from-env';
    expect(await runtimeSecret('HOTLINE_RELAY_SECRET')).toBe('from-env');
  });

  it('vault подключён, но ключа нет — env-фолбэк (пустая комната молчит)', async () => {
    envVaultOn();
    process.env.HOTLINE_RELAY_SECRET = 'from-env';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ secrets: {} })),
    );
    expect(await runtimeSecret('HOTLINE_RELAY_SECRET')).toBe('from-env');
  });

  it('vault недоступен — null (fail-closed: роут ответит 503)', async () => {
    envVaultOn();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await runtimeSecret('HOTLINE_RELAY_SECRET')).toBeNull();
  });

  it('кэш по TTL: повторное обращение — без повторного fetch', async () => {
    envVaultOn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ secrets: { HOTLINE_RELAY_SECRET: 'from-vault' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await runtimeSecret('HOTLINE_RELAY_SECRET');
    await runtimeSecret('HOTLINE_RELAY_SECRET');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('по TTL — повторное восстановление (ротация перекрытием подхватывается)', async () => {
    vi.useFakeTimers();
    envVaultOn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ secrets: { HOTLINE_RELAY_SECRET: 'token-v1' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(await runtimeSecret('HOTLINE_RELAY_SECRET')).toBe('token-v1');
    vi.setSystemTime(Date.now() + 11 * 60_000);
    fetchMock.mockResolvedValue(
      Response.json({ secrets: { HOTLINE_RELAY_SECRET: 'token-v2' } }),
    );
    expect(await runtimeSecret('HOTLINE_RELAY_SECRET')).toBe('token-v2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stale-while-revalidate: vault упал — отдаём последний кэш', async () => {
    vi.useFakeTimers();
    envVaultOn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ secrets: { HOTLINE_RELAY_SECRET: 'cached-value' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(await runtimeSecret('HOTLINE_RELAY_SECRET')).toBe('cached-value');
    vi.setSystemTime(Date.now() + 11 * 60_000);
    fetchMock.mockRejectedValue(new Error('vault down'));
    expect(await runtimeSecret('HOTLINE_RELAY_SECRET')).toBe('cached-value');
  });

  it('параллельные обращения — один fetch (inflight-гейт)', async () => {
    envVaultOn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ secrets: { HOTLINE_RELAY_SECRET: 'v' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const [a, b, c] = await Promise.all([
      runtimeSecret('HOTLINE_RELAY_SECRET'),
      runtimeSecret('HOTLINE_RELAY_SECRET'),
      runtimeSecret('HOTLINE_RELAY_SECRET'),
    ]);
    expect([a, b, c]).toEqual(['v', 'v', 'v']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
