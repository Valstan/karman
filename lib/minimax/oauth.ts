import { createHash, randomBytes } from 'node:crypto';

/**
 * OAuth device-flow MiniMax Code — добыча токена агента для аккаунта.
 *
 * РЕЦЕПТ (Сарафан, линия «Телефона», 14.11; проверен им живьём на реальном
 * аккаунте): у MiniMax НЕТ гранта «пароль» (`grant_type=password` → HTTP 400
 * `invalid_request`), а веб-вход панели шифрует пароль RSA с ключом, вшитым в
 * клиент, — это веб-сессия, а не токен агента. Токен агента выдаётся ТОЛЬКО через
 * device-flow:
 *
 * 1) PKCE: `code_verifier` (случайные 43–128 байт), `code_challenge` =
 *    base64url(sha256(code_verifier));
 * 2) `POST https://account.minimax.io/oauth2/device/code`, form: `client_id=mcode-public`,
 *    `scope=agent.default`, `audience=agent-backend`, `code_challenge`,
 *    `code_challenge_method=S256` → `device_code`, `user_code`, `verification_uri`,
 *    `interval`, `expires_in`;
 * 3) владелец открывает `https://account.minimax.io/oauth-authorize?user_code=<user_code>`
 *    в браузере, входит и подтверждает; код живёт ~10 минут;
 * 4) `POST https://account.minimax.io/oauth2/token`, form:
 *    `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id=mcode-public`,
 *    `device_code`, `code_verifier` → `access_token`, `refresh_token`, `expires_in` (~3600 с).
 *
 * **Refresh-токен одноразовый:** вендер считает повторное использование злоупотреблением
 * и отзывает цепочку. Поэтому добытая пара хранится шифротекстом и отдаётся проекту
 * ОДИН раз (см. `lib/services/account-tokens.ts`).
 *
 * Модуль без БД и без server-only — юнит-тестируется (fetch подменяется).
 */

const DEVICE_CODE_URL = 'https://account.minimax.io/oauth2/device/code';
const TOKEN_URL = 'https://account.minimax.io/oauth2/token';

/** Публичный клиент MiniMax Code (тот же, что у соседей). */
export const MINIMAX_OAUTH_CLIENT_ID = 'mcode-public';
export const MINIMAX_OAUTH_SCOPE = 'agent.default';
export const MINIMAX_OAUTH_AUDIENCE = 'agent-backend';
export const MINIMAX_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Коды ошибок, которые вендер отдаёт на обмен кода. */
export type DeviceFlowError =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied'
  | 'network'
  | 'unknown';

export type DeviceFlowStart = {
  /** Секрет обмена: им меняют код на пару токенов. */
  deviceCode: string;
  /** Код, который владелец вводит на странице MiniMax (не секрет). */
  userCode: string;
  /** Страница подтверждения. */
  verificationUri: string;
  /**
   * Готовая ссылка с кодом внутри (вендер отдаёт её сам, живая проба 14.11:
   * `verification_uri_complete`). Если её нет — собираем из `verification_uri` и
   * `user_code`.
   */
  verificationUriComplete: string | null;
  /** Как часто можно опрашивать обмен (секунды). */
  intervalSeconds: number;
  /** Сколько живёт код (секунды). */
  expiresInSeconds: number;
};

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
};

export type OAuthResult<T> = { ok: true; data: T } | { ok: false; error: DeviceFlowError; message?: string };

/** PKCE-пара: verifier и его challenge (RFC 7636, S256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: codeChallenge(verifier) };
}

/** code_challenge = base64url(sha256(code_verifier)) — ровно как требует MiniMax. */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

/** Полная ссылка подтверждения: у MiniMax код вводится вручную на странице. */
export function verificationLink(verificationUri: string, userCode: string): string {
  const separator = verificationUri.includes('?') ? '&' : '?';
  return `${verificationUri}${separator}user_code=${encodeURIComponent(userCode)}`;
}

/** Завести device-flow: MiniMax вернёт код для подтверждения владельцем. */
export async function startDeviceFlow(
  challenge: string,
  signal?: AbortSignal,
): Promise<OAuthResult<DeviceFlowStart>> {
  const body = new URLSearchParams({
    client_id: MINIMAX_OAUTH_CLIENT_ID,
    scope: MINIMAX_OAUTH_SCOPE,
    audience: MINIMAX_OAUTH_AUDIENCE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  let response: Response;
  try {
    response = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    });
  } catch {
    return { ok: false, error: 'network', message: 'MiniMax недоступен' };
  }

  const payload = await readJson(response);
  if (!response.ok) {
    return {
      ok: false,
      error: 'unknown',
      message: errorMessage(payload) ?? `MiniMax ответил ${response.status}`,
    };
  }

  const deviceCode = stringField(payload, 'device_code');
  const userCode = stringField(payload, 'user_code');
  const verificationUri = stringField(payload, 'verification_uri');
  if (!deviceCode || !userCode || !verificationUri) {
    return { ok: false, error: 'unknown', message: 'MiniMax не вернул device_code/user_code' };
  }

  return {
    ok: true,
    data: {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: stringField(payload, 'verification_uri_complete'),
      intervalSeconds: numberField(payload, 'interval') ?? 5,
      expiresInSeconds: numberField(payload, 'expires_in') ?? 600,
    },
  };
}

/**
 * Обменять подтверждённый код на пару токенов.
 *
 * Пока владелец не подтвердил — вендер отдаёт `authorization_pending`: это НЕ ошибка,
 * а «жди». Истечение срока — `expired_token`: нужен новый flow.
 */
export async function exchangeDeviceCode(
  deviceCode: string,
  codeVerifier: string,
  signal?: AbortSignal,
): Promise<OAuthResult<TokenPair>> {
  const body = new URLSearchParams({
    grant_type: MINIMAX_OAUTH_GRANT_TYPE,
    client_id: MINIMAX_OAUTH_CLIENT_ID,
    device_code: deviceCode,
    code_verifier: codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    });
  } catch {
    return { ok: false, error: 'network', message: 'MiniMax недоступен' };
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const code = stringField(payload, 'error') ?? '';
    const error = mapError(code);
    return { ok: false, error, message: errorMessage(payload) ?? code ?? `HTTP ${response.status}` };
  }

  const accessToken = stringField(payload, 'access_token');
  const refreshToken = stringField(payload, 'refresh_token');
  if (!accessToken || !refreshToken) {
    return { ok: false, error: 'unknown', message: 'MiniMax не вернул пару токенов' };
  }
  return {
    ok: true,
    data: {
      accessToken,
      refreshToken,
      expiresInSeconds: numberField(payload, 'expires_in') ?? 3600,
    },
  };
}

/** Ошибки вендера → наши коды. Неизвестное — 'unknown' с текстом вендера. */
function mapError(code: string): DeviceFlowError {
  switch (code) {
    case 'authorization_pending':
      return 'authorization_pending';
    case 'slow_down':
      return 'slow_down';
    case 'expired_token':
      return 'expired_token';
    case 'access_denied':
      return 'access_denied';
    default:
      return 'unknown';
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length ? value : null;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorMessage(payload: Record<string, unknown>): string | null {
  const value = payload['error_description'] ?? payload['message'] ?? payload['error'];
  return typeof value === 'string' && value.length ? value : null;
}
