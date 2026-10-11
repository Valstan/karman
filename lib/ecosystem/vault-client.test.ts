import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VaultHttpError,
  vaultClientFromEnv,
} from '@/lib/ecosystem/vault-client';

const saved = {
  VAULT_URL: process.env.VAULT_URL,
  SECRETS_TOKEN: process.env.SECRETS_TOKEN,
};

beforeEach(() => {
  delete process.env.VAULT_URL;
  delete process.env.SECRETS_TOKEN;
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (saved.VAULT_URL === undefined) delete process.env.VAULT_URL;
  else process.env.VAULT_URL = saved.VAULT_URL;
  if (saved.SECRETS_TOKEN === undefined) delete process.env.SECRETS_TOKEN;
  else process.env.SECRETS_TOKEN = saved.SECRETS_TOKEN;
});

function envOn() {
  process.env.VAULT_URL = 'https://vault.example/';
  process.env.SECRETS_TOKEN = 'skm_test-token';
}

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

describe('vaultClientFromEnv', () => {
  it('null, пока vault не подключён (нет VAULT_URL или SECRETS_TOKEN)', () => {
    expect(vaultClientFromEnv()).toBeNull();
    process.env.VAULT_URL = 'https://vault.example';
    expect(vaultClientFromEnv()).toBeNull();
    delete process.env.VAULT_URL;
    process.env.SECRETS_TOKEN = 'skm_x';
    expect(vaultClientFromEnv()).toBeNull();
  });

  it('loadAll: GET без key, секреты из тела ответа', async () => {
    envOn();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ secrets: { A: '1', B: '2' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = vaultClientFromEnv()!;
    expect(await client.loadAll()).toEqual({ A: '1', B: '2' });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://vault.example/api/secrets');
    expect(init?.headers).toEqual({ Authorization: 'Bearer skm_test-token' });
  });

  it('loadAll: пустая комната — {} без молчаливой ошибки (G331 допускает)', async () => {
    envOn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ secrets: {} })),
    );
    expect(await vaultClientFromEnv()!.loadAll()).toEqual({});
  });

  it('loadExpect: промах ключа — громкая ошибка 404 с missing (G331)', async () => {
    envOn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ error: 'Не найдено ключей: 1 из 2', missing: ['MISSING'] }, 404),
      ),
    );
    const client = vaultClientFromEnv()!;
    await expect(client.loadExpect(['HAVE', 'MISSING'])).rejects.toMatchObject({
      status: 404,
    });
    const [url] = (vi.mocked(fetch).mock.calls[0]! as [string, RequestInit]);
    // Запятая — разделитель ключей формы ?key=A,B (контракт client-guide).
    expect(url).toBe('https://vault.example/api/secrets?key=HAVE,MISSING');
  });

  it('loadExpect без ключей — то же, что loadAll', async () => {
    envOn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ secrets: { A: '1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = vaultClientFromEnv()!;
    expect(await client.loadExpect([])).toEqual({ A: '1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('save: POST с телом {secrets}, возвращает written', async () => {
    envOn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, written: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = vaultClientFromEnv()!;
    expect(await client.save({ A: '1', B: '2' })).toBe(2);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://vault.example/api/secrets');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ secrets: { A: '1', B: '2' } }));
  });

  it('HTTP-ошибка — VaultHttpError со статусом и телом', async () => {
    envOn();
    // Свежий Response на каждый вызов: тело Response читается один раз.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(new Response('Требуется Bearer-токен', { status: 401 })),
      ),
    );
    const client = vaultClientFromEnv()!;
    await expect(client.loadAll()).rejects.toBeInstanceOf(VaultHttpError);
    await expect(client.loadAll()).rejects.toMatchObject({
      status: 401,
      body: 'Требуется Bearer-токен',
    });
  });

  it('слэши на конце базового адреса не дублируются в эндпоинте', async () => {
    process.env.VAULT_URL = 'https://vault.example///';
    process.env.SECRETS_TOKEN = 'skm_t';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ secrets: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await vaultClientFromEnv()!.loadAll();
    const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://vault.example/api/secrets');
  });
});
