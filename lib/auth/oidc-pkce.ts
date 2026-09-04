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
  /**
   * `null` — провайдер его не объявил или объявил негодным. Поле обязательное,
   * но nullable: так компилятор укажет каждое место сборки, а отсутствие
   * эндпоинта не ломает вход (см. `UserinfoOutcome`).
   */
  userinfoEndpoint: string | null;
};

export type OidcClaims = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
};

/**
 * Чем закончилось обращение к `userinfo` — пишется в аудит на каждый вход.
 *
 * Зачем исход вообще существует. Запрос к `userinfo` необязателен и его провал
 * НЕ валит вход (обоснование — у `fetchUserinfo`). Но мягкий отказ молча прячет
 * дефект: именно так владелец получил три `esa_resolve_fail:not_invited` с
 * пустой почтой и не имел ни одной подсказки, почему. Поэтому мягкость обязана
 * быть громкой: следующий разбор — один SELECT по `auth_audit`, а не чтение
 * исходников.
 */
export type UserinfoOutcome =
  /** id_token уже дал всё нужное — в сеть не ходим вовсе. */
  | 'skipped_complete'
  | 'no_endpoint'
  | 'no_access_token'
  | `http_${number}`
  | 'network'
  | 'not_json'
  /** Ответ подписан (application/jwt) — такой клиент мы не регистрировали. */
  | 'jwt_response'
  | 'too_large'
  /** `sub` не совпал с id_token — ответ отброшен целиком (OIDC Core 5.3.2). */
  | 'sub_mismatch'
  | 'ok_filled'
  | 'ok_nothing_new';

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
  mode: 'login' | 'link' = 'login',
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
  if (mode === 'link') {
    // Привязка обязана спросить ИМЕННО ТОГО, кто жмёт кнопку. Без `prompt=login`
    // провайдер молча переиспользует сессию, уже открытую в браузере: подложи
    // туда кто-нибудь свою — и человек привяжет к своему аккаунту ЧУЖУЮ
    // личность, то есть отдаст чужому ключ от своей двери. При входе такого
    // требования нет: там переиспользование сессии и есть смысл единого входа.
    url.searchParams.set('prompt', 'login');
    url.searchParams.set('max_age', '0');
  }
  return url.toString();
}

// --- userinfo: чистые решения ------------------------------------------------

/** Длина колонки `auth_oidc_identity.email` (varchar(254)). */
const EMAIL_MAX = 254;

/**
 * Годная ли почта, чтобы вести по ней привязку и класть в БД.
 *
 * Проверка длины здесь не косметика: строка длиннее колонки уронила бы INSERT
 * в `resolveOidcLogin` уже ПОСЛЕ успешной проверки подписи — то есть вход
 * падал бы пятисоткой в самом конце, а причина лежала бы в неподписанном
 * ответе стороннего сервиса.
 */
function usableEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= EMAIL_MAX && v.includes('@');
}

/**
 * Адрес `userinfo` из discovery-документа — или `null`, если он негоден.
 *
 * Требования жёстче, чем к остальным эндпоинтам, потому что сюда уедет живой
 * `access_token`: только https и только тот же хост, что у issuer'а. Discovery
 * уже сверен по полю `issuer` (см. `esaEndpoints`), но подменённый или просто
 * неряшливый документ мог бы увести токен на сторонний хост — а это выдача
 * доступа к профилю тому, кого мы не спрашивали.
 */
export function pickUserinfoEndpoint(d: Record<string, unknown>, issuer: string): string | null {
  const raw = d.userinfo_endpoint;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let url: URL;
  let issuerUrl: URL;
  try {
    url = new URL(raw);
    issuerUrl = new URL(issuer);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== issuerUrl.hostname) return null;
  return url.toString();
}

/** Нужно ли вообще ходить в сеть: id_token уже принёс всё, что мы оттуда берём. */
export function userinfoNeeded(claims: OidcClaims): boolean {
  return !(claims.email !== null && claims.emailVerified && claims.name !== null);
}

/**
 * Слить ответ `userinfo` с проверенными claims из id_token.
 *
 * Два правила, оба принципиальные.
 *
 * 1. **`sub` обязан совпасть.** Не совпал — ответ отбрасывается ЦЕЛИКОМ, ни
 *    одно поле не берётся. Иначе чужой профиль (подставленный или пришедший
 *    из-за путаницы токенов у провайдера) привязал бы чужую почту к входу,
 *    а на почте стоит вся ветка привязки к существующему аккаунту.
 * 2. **`userinfo` ДОПОЛНЯЕТ, но не переопределяет.** Подписан именно id_token;
 *    ответ `userinfo` — обычный JSON по TLS, без подписи. Разреши он
 *    переопределение — неподписанный ответ подменял бы подписанное
 *    утверждение, что и есть подмена личности.
 */
export function mergeUserinfo(
  claims: OidcClaims,
  body: unknown,
): { claims: OidcClaims; outcome: UserinfoOutcome } {
  if (typeof body !== 'object' || body === null) {
    return { claims, outcome: 'not_json' };
  }
  const d = body as Record<string, unknown>;
  if (d.sub !== claims.subject) {
    return { claims, outcome: 'sub_mismatch' };
  }

  const merged: OidcClaims = { ...claims };
  let filled = false;

  if (merged.email === null && usableEmail(d.email)) {
    merged.email = d.email;
    // `email_verified` берётся строго булевым true — та же строгость, что для
    // id_token. Строка "true" не считается: на этом флаге стоит доступ к чужой
    // учётке, и «почти подтверждено» здесь означает «не подтверждено».
    merged.emailVerified = d.email_verified === true;
    filled = true;
  }

  if (merged.name === null && typeof d.name === 'string' && d.name.length > 0) {
    merged.name = d.name;
    filled = true;
  }

  return { claims: merged, outcome: filled ? 'ok_filled' : 'ok_nothing_new' };
}
