import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  exchangeDeviceCode,
  MINIMAX_OAUTH_CLIENT_ID,
  MINIMAX_OAUTH_GRANT_TYPE,
  pkcePair,
  startDeviceFlow,
  verificationLink,
} from '@/lib/minimax/oauth';

/**
 * Гейт OAuth device-flow MiniMax (рецепт Сарафана, линия «Телефона», 14.11).
 *
 * Проверяем ровно то, на чём держится добыча токена: PKCE-пара (S256), форма запроса
 * device/code и обмена, и разбор ошибок вендера — `authorization_pending` это «жди», а
 * не поломка, `expired_token` — нужен новый flow.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(response: Response) {
  const spy = vi.fn(async () => response);
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PKCE', () => {
  it('verifier — 43 символа base64url, challenge = base64url(sha256(verifier))', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(createHash('sha256').update(verifier, 'utf8').digest('base64url'));
  });

  it('две пары разные — verifier одноразовый', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });
});

describe('device-flow: заявка кода', () => {
  it('форма запроса — как в рецепте: client_id, scope, audience, challenge, S256', async () => {
    const spy = mockFetch(
      jsonResponse({
        device_code: 'dev-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://account.minimax.io/oauth-authorize',
        interval: 5,
        expires_in: 600,
      }),
    );

    const result = await startDeviceFlow('challenge-xyz');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deviceCode).toBe('dev-123');
    expect(result.data.userCode).toBe('ABCD-1234');
    expect(result.data.intervalSeconds).toBe(5);
    expect(result.data.expiresInSeconds).toBe(600);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://account.minimax.io/oauth2/device/code');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe(MINIMAX_OAUTH_CLIENT_ID);
    expect(body.get('scope')).toBe('agent.default');
    expect(body.get('audience')).toBe('agent-backend');
    expect(body.get('code_challenge')).toBe('challenge-xyz');
    expect(body.get('code_challenge_method')).toBe('S256');
  });

  it('ответ без device_code — ошибка, а не «получили»', async () => {
    mockFetch(jsonResponse({ user_code: 'ABCD' }));
    const result = await startDeviceFlow('challenge');
    expect(result.ok).toBe(false);
  });

  it('готовая ссылка с кодом (verification_uri_complete) — берём её', async () => {
    // Живая проба 14.11: вендер отдаёт её сам, и в ней уже есть user_code.
    mockFetch(
      jsonResponse({
        device_code: 'dev-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://account.minimax.io/oauth-authorize',
        verification_uri_complete: 'https://account.minimax.io/oauth-authorize?user_code=ABCD-1234',
        interval: 3,
        expires_in: 300,
      }),
    );
    const result = await startDeviceFlow('challenge');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.verificationUriComplete).toBe(
      'https://account.minimax.io/oauth-authorize?user_code=ABCD-1234',
    );
    // Живые значения вендера: опрашивать можно чаще, код живёт 5 минут.
    expect(result.data.intervalSeconds).toBe(3);
    expect(result.data.expiresInSeconds).toBe(300);
  });

  it('сеть недоступна — это «network», а не пустота', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    const result = await startDeviceFlow('challenge');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('network');
  });
});

describe('device-flow: обмен кода на пару', () => {
  it('форма обмена — grant_type=device_code, client_id, device_code, code_verifier', async () => {
    const spy = mockFetch(
      jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
    );

    const result = await exchangeDeviceCode('dev-123', 'verifier-xyz');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.accessToken).toBe('at-1');
    expect(result.data.refreshToken).toBe('rt-1');
    expect(result.data.expiresInSeconds).toBe(3600);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://account.minimax.io/oauth2/token');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe(MINIMAX_OAUTH_GRANT_TYPE);
    expect(body.get('client_id')).toBe(MINIMAX_OAUTH_CLIENT_ID);
    expect(body.get('device_code')).toBe('dev-123');
    expect(body.get('code_verifier')).toBe('verifier-xyz');
  });

  it('authorization_pending — это «жди», а не ошибка', async () => {
    mockFetch(jsonResponse({ error: 'authorization_pending' }, 400));
    const result = await exchangeDeviceCode('dev', 'ver');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('authorization_pending');
  });

  it('expired_token — нужен новый flow', async () => {
    mockFetch(jsonResponse({ error: 'expired_token' }, 400));
    const result = await exchangeDeviceCode('dev', 'ver');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('expired_token');
  });

  it('ответ без пары — ошибка, а не половина токена', async () => {
    mockFetch(jsonResponse({ access_token: 'at-1' }));
    const result = await exchangeDeviceCode('dev', 'ver');
    expect(result.ok).toBe(false);
  });
});

describe('ссылка подтверждения', () => {
  it('код вшит в query — MiniMax ждёт user_code в адресе', () => {
    const link = verificationLink('https://account.minimax.io/oauth-authorize', 'ABCD-1234');
    expect(link).toBe('https://account.minimax.io/oauth-authorize?user_code=ABCD-1234');
  });

  it('у адреса с query — второй параметр, а не второй знак вопроса', () => {
    const link = verificationLink('https://account.minimax.io/oauth-authorize?x=1', 'ABCD');
    expect(link).toBe('https://account.minimax.io/oauth-authorize?x=1&user_code=ABCD');
  });
});
