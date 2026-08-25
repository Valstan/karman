/**
 * Чистая часть входа через ЕСА: конфигурация, PKCE и сборка URL авторизации.
 *
 * Вынесено из `oidc.ts` по конвенции проекта (как `lib/secrets/crypto.ts`):
 * модуль без `server-only` юнит-тестируется, а всё, что ходит в сеть и в БД,
 * остаётся в серверном модуле. Здесь нет ни одного побочного эффекта, поэтому
 * PKCE проверяется контрольным вектором RFC, а не сквозным прогоном.
 */

import { createHash, randomBytes } from 'node:crypto';

export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
};

export type OidcEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
};

/** Конфигурация задана целиком — иначе кнопки входа не показываем вовсе. */
export function esaConfig(): OidcConfig | null {
  const issuer = process.env.ESA_ISSUER?.trim();
  const clientId = process.env.ESA_CLIENT_ID?.trim();
  const clientSecret = process.env.ESA_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer, clientId, clientSecret };
}


// --- PKCE и одноразовые величины ---------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export type AuthRequest = {
  state: string;
  nonce: string;
  codeVerifier: string;
};

export function newAuthRequest(): AuthRequest {
  return {
    state: b64url(randomBytes(24)),
    nonce: b64url(randomBytes(24)),
    // 32 байта -> 43 символа base64url, внутри допустимых 43..128 (RFC 7636).
    codeVerifier: b64url(randomBytes(32)),
  };
}

export function codeChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

export function buildAuthorizeUrl(
  endpoints: OidcEndpoints,
  cfg: OidcConfig,
  req: AuthRequest,
  redirectUri: string,
): string {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', req.state);
  url.searchParams.set('nonce', req.nonce);
  url.searchParams.set('code_challenge', codeChallenge(req.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
