import { describe, expect, it } from 'vitest';

// @ts-expect-error .mjs без деклараций — импортируем как есть (мандат brain 2026-09-09).
import { describeFailure, oidcRequestUrl, runPassportStep, summarizeSession } from './vault-passport-step.mjs';

/**
 * Гейт шага паспортного входа (ADR-0012 мозга, волна 0; мандат D-241 19.11).
 *
 * Требования, которые шаг обязан выполнять:
 *   1) взять удостоверение прогона (OIDC) и обменять его на токен своей комнаты;
 *   2) **никогда не печатать токен** — только slug, право и префикс;
 *   3) погасить сессию — даже если обмен на постоянный токен упал;
 *   4) падать ВНЯТРИ (ненулевой код, внятное сообщение), а не «почти готово».
 */

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://runner/token',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-secret',
  KARMAN_VAULT_AUDIENCE: 'karman-vault',
};

describe('паспортный шаг деплоя', () => {
  it('берёт удостоверение прогона с нашим audience', () => {
    const { url, token } = oidcRequestUrl(ENV);
    expect(url).toContain('audience=karman-vault');
    expect(token).toBe('runner-secret');
  });

  it('без id-token шаг падает внятно, а не молча', () => {
    expect(() => oidcRequestUrl({})).toThrow(/permissions: id-token: write/);
  });

  it('токен не попадает в журнал — только slug, право и префикс', async () => {
    const lines: string[] = [];
    const fetchImpl = async (url: string) => {
      if (String(url).includes('runner/token')) {
        return { ok: true, status: 200, json: async () => ({ value: 'jwt' }), text: async () => 'jwt' };
      }
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({ ok: true, token: 'skm_SECRET', tokenPrefix: 'skm_ab', slug: 'karman', canWrite: true }),
      };
    };
    const result = await runPassportStep({
      base: 'https://karman.test',
      env: ENV,
      fetchImpl: fetchImpl as never,
      log: (line: string) => lines.push(line),
    });

    expect(result.slug).toBe('karman');
    expect(lines.join('\n')).not.toContain('skm_SECRET');
    expect(lines.join('\n')).toContain('комната karman');
  });

  it('сессия гасится даже когда обмен на постоянный токен упал', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (String(url).includes('runner/token')) {
        return { ok: true, status: 200, json: async () => ({ value: 'jwt' }), text: async () => 'jwt' };
      }
      if (String(url).endsWith('/api/secrets/claim')) {
        return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'Недействительный код' }) };
      }
      if (init?.method === 'DELETE') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
      }
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ ok: true, token: 'skm_SECRET', tokenPrefix: 'skm_ab', slug: 'karman', canWrite: true }),
      };
    };

    await expect(
      runPassportStep({
        base: 'https://karman.test',
        env: ENV,
        fetchImpl: fetchImpl as never,
        claim: true,
        log: () => {},
      }),
    ).rejects.toThrow(/обмен на постоянный токен не состоялся/);

    expect(calls.some((c) => c.startsWith('DELETE') && c.includes('/api/secrets/session'))).toBe(true);
  });

  it('незарегистрированная личность — внятный отказ, а не тишина', async () => {
    const fetchImpl = async (url: string) => {
      if (String(url).includes('runner/token')) {
        return { ok: true, status: 200, json: async () => ({ value: 'jwt' }), text: async () => 'jwt' };
      }
      return { ok: false, status: 403, text: async () => JSON.stringify({ error: 'Личность не зарегистрирована' }) };
    };
    await expect(
      runPassportStep({
        base: 'https://karman.test',
        env: ENV,
        fetchImpl: fetchImpl as never,
        log: () => {},
      }),
    ).rejects.toThrow(/Личность не зарегистрирована/);
  });

  it('сводка по сессии не содержит сам токен', () => {
    const summary = summarizeSession({ token: 'skm_SECRET', slug: 'karman', canWrite: true, tokenPrefix: 'skm_ab' });
    expect(summary).toEqual({ slug: 'karman', canWrite: true, tokenPrefix: 'skm_ab', expiresAt: null });
    expect(JSON.stringify(summary)).not.toContain('skm_SECRET');
  });

  it('текст ошибки — код и сообщение сервера', () => {
    expect(describeFailure(403, JSON.stringify({ error: 'Личность не зарегистрирована' }))).toBe(
      'HTTP 403: Личность не зарегистрирована',
    );
    expect(describeFailure(500, 'not json')).toBe('HTTP 500');
  });
});
