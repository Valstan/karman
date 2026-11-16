import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  exchangeDeviceCode,
  MINIMAX_OAUTH_CLIENT_ID,
  MINIMAX_OAUTH_GRANT_TYPE,
  pkcePair,
  refreshAccessToken,
  signinStatus,
  startDeviceFlow,
  verificationLink,
} from '@/lib/minimax/oauth';

/**
 * Гейт OAuth device-flow MiniMax (рецепт Сарафана, линия «Телефона», 14.11).
 *
 * Проверяем ровно то, на чём держится добыча токена: PKCE-пара (S256), форма запроса
 * device/code и обмена, разбор ошибок вендора — `authorization_pending` это «жди», а
 * не поломка, `expired_token` — нужен новый flow.
 *
 * С 15.11 добавились две вещи: **продление цепочки по refresh** (refresh одноразовый,
 * но обновление возвращает новую пару целиком) и **чтение панели чекина**
 * (`signin/status`) — источник правды о том, есть ли у аккаунта сегодняшние очки.
 * Чтение ничего не тратит.
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

describe('refresh: продление цепочки', () => {
  it('форма — grant_type=refresh_token, client_id, refresh_token', async () => {
    // Refresh одноразовый, но вместе с новым access вендор отдаёт новый refresh:
    // цепочка продлевается (живая проба 15.11).
    const spy = mockFetch(
      jsonResponse({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 43_200 }),
    );

    const result = await refreshAccessToken('rt-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.accessToken).toBe('at-2');
    expect(result.data.refreshToken).toBe('rt-2');
    expect(result.data.expiresInSeconds).toBe(43_200);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://account.minimax.io/oauth2/token');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(MINIMAX_OAUTH_CLIENT_ID);
    expect(body.get('refresh_token')).toBe('rt-1');
  });

  it('invalid_grant — цепочка оборвана: нужен новый вход', async () => {
    mockFetch(jsonResponse({ error: 'invalid_grant' }, 400));
    const result = await refreshAccessToken('rt-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('invalid_grant');
  });

  it('ответ без пары — ошибка: без нового refresh цепочка оборвётся', async () => {
    mockFetch(jsonResponse({ access_token: 'at-2' }));
    const result = await refreshAccessToken('rt-1');
    expect(result.ok).toBe(false);
  });
});

describe('панель чекина: signin/status', () => {
  const panel = {
    data: {
      scene: 2,
      days: [
        { day_no: 1, status: 3, points: 400, is_today: false, bonus_points: 0 },
        { day_no: 2, status: 3, points: 400, is_today: false, bonus_points: 0 },
        { day_no: 3, status: 3, points: 400, is_today: false, bonus_points: 0 },
        { day_no: 4, status: 3, points: 1000, is_today: false, bonus_points: 0 },
        { day_no: 5, status: 2, points: 400, is_today: true, bonus_points: 0 },
        { day_no: 6, status: 1, points: 400, is_today: false, bonus_points: 0 },
        { day_no: 7, status: 1, points: 1000, is_today: false, bonus_points: 0 },
      ],
    },
    base_resp: { status_code: 0, status_msg: 'ok' },
  };

  it('читает состояние суток и понимает, что очки можно забрать', async () => {
    const spy = mockFetch(jsonResponse(panel));
    const result = await signinStatus('at-1', 'Europe/Moscow');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.days).toHaveLength(7);
    // Клетка «сегодня» — status 2 («можно забрать»), очки 400.
    expect(result.data.today?.day_no).toBe(5);
    expect(result.data.canClaim).toBe(true);
    expect(result.data.points).toBe(400);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('https://agent.minimax.io/minimax-cloud/api/v1/signin/status');
    // Часовой пояс обязателен: без него вендор отвечает «invalid timezone_id».
    expect(url).toContain('timezone_id=Europe%2FMoscow');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at-1');
  });

  it('клетка забрана — очков нет, аккаунт отдавать нельзя', async () => {
    mockFetch(
      jsonResponse({
        ...panel,
        data: {
          ...panel.data,
          days: panel.data.days.map((d) => (d.is_today ? { ...d, status: 3 } : d)),
        },
      }),
    );
    const result = await signinStatus('at-1', 'UTC');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.canClaim).toBe(false);
  });

  it('панель недоступна — это «не знаю», а не «очков нет»', async () => {
    mockFetch(jsonResponse({ error: 'unauthorized' }, 401));
    const result = await signinStatus('at-1', 'Europe/Moscow');
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
