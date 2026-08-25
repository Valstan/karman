import 'server-only';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { getJwks } from '@/lib/passport/jwks';
import type { OidcConfig, OidcEndpoints } from './oidc-pkce';

export * from './oidc-pkce';

/**
 * Вход через ЕСА — единый вход экосистемы (OIDC Authorization Code + PKCE, RS256).
 *
 * Это ВТОРОЙ путь входа, а не замена паролю (решение владельца 2026-08-25).
 * Пароль с TOTP остаётся аварийным: ЕСА живёт на чужой машине, а КАРМАН держит
 * хранилище секретов всей экосистемы. Прецедент прямой: аккаунт владельца ВКонтакте
 * был в бане с 12 по 18 августа — будь ЕСА единственным входом, владелец не попал бы
 * в собственный vault шесть дней. Поэтому «дополнительная кнопка», и поэтому же
 * второй фактор спрашивается и после ЕСА.
 *
 * Разделение с паспортным сервером (`lib/passport/*`): там машина предъявляет
 * удостоверение своего CI, здесь человек проходит браузерный редирект. Общее у них
 * ровно одно — снимок JWKS, поэтому переиспользуется `getJwks` (кеш в БД,
 * cooldown + stale-if-error), а не заводится второй кеш ключей.
 */

const DISCOVERY_TIMEOUT_MS = 5_000;
const TOKEN_TIMEOUT_MS = 8_000;

/** Discovery меняется редко; снимок в памяти процесса — инстанс один. */
const DISCOVERY_TTL_MS = 60 * 60_000;

let discoveryCache: { at: number; issuer: string; endpoints: OidcEndpoints } | null = null;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Эндпоинты провайдера из его discovery-документа.
 *
 * Читаем из discovery, а не зашиваем в код: у OIDC issuer вправе их менять, и
 * зашитый путь ломается молча — редиректом в никуда, который снаружи выглядит
 * как «вход не работает». Проверяем при этом, что `issuer` в документе совпадает
 * с тем, куда мы ходили: несовпадение означает подменённый discovery.
 */
export async function esaEndpoints(cfg: OidcConfig): Promise<OidcEndpoints> {
  const now = Date.now();
  if (discoveryCache && discoveryCache.issuer === cfg.issuer && now - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.endpoints;
  }

  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);

  const body: unknown = await res.json();
  const d = body as Record<string, unknown>;
  if (d.issuer !== cfg.issuer) {
    throw new Error('discovery отдал чужой issuer');
  }
  if (
    !isNonEmptyString(d.authorization_endpoint) ||
    !isNonEmptyString(d.token_endpoint) ||
    !isNonEmptyString(d.jwks_uri)
  ) {
    throw new Error('в discovery нет обязательных эндпоинтов');
  }

  const endpoints: OidcEndpoints = {
    authorizationEndpoint: d.authorization_endpoint,
    tokenEndpoint: d.token_endpoint,
    jwksUri: d.jwks_uri,
  };
  discoveryCache = { at: now, issuer: cfg.issuer, endpoints };
  return endpoints;
}

// --- Обмен кода и проверка удостоверения --------------------------------------

export type OidcFailure = {
  ok: false;
  /** Короткий код для аудита; наружу уходит общая формулировка. */
  reason:
    | 'not_configured'
    | 'discovery_failed'
    | 'token_http_error'
    | 'id_token_missing'
    | 'alg_not_allowed'
    | 'jwks_unavailable'
    | 'bad_signature'
    | 'nonce_mismatch'
    | 'subject_missing';
  detail: string;
};

export type OidcClaims = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
};

export type OidcResult = { ok: true; claims: OidcClaims } | OidcFailure;

function fail(reason: OidcFailure['reason'], detail: string): OidcFailure {
  return { ok: false, reason, detail };
}

/**
 * Асимметричные подписи только. HS* принял бы за ключ подписи ЛЮБУЮ строку из
 * JWKS, то есть публичный ключ провайдера стал бы секретом — классическая
 * подмена alg. Список тот же, что у паспортного верификатора.
 */
const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384'];

const CLOCK_TOLERANCE_SECONDS = 30;

export async function exchangeAndVerify(
  cfg: OidcConfig,
  endpoints: OidcEndpoints,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  expectedNonce: string,
): Promise<OidcResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: codeVerifier,
  });

  let res: Response;
  try {
    res = await fetch(endpoints.tokenEndpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      cache: 'no-store',
    });
  } catch (e) {
    return fail('token_http_error', `сеть: ${e instanceof Error ? e.message : 'ошибка'}`);
  }

  if (!res.ok) {
    // В детали кладём КОД, а не тело: за 502/504 отвечает прокси, и его страница
    // штатно содержит хостнейм и версию ПО. Наружу — только поля по имени.
    return fail('token_http_error', `token endpoint HTTP ${res.status}`);
  }

  const payload = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  const idToken = payload?.id_token;
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return fail('id_token_missing', 'в ответе token endpoint нет id_token');
  }

  let header: { alg?: string };
  try {
    header = decodeProtectedHeader(idToken);
  } catch {
    return fail('bad_signature', 'id_token не разбирается');
  }
  if (!header.alg || !ALLOWED_ALGS.includes(header.alg)) {
    return fail('alg_not_allowed', `alg=${header.alg ?? 'нет'}`);
  }

  const snapshot = await getJwks(endpoints.jwksUri);
  if (!snapshot) {
    return fail('jwks_unavailable', 'снимка ключей провайдера нет вовсе');
  }

  let claims: Record<string, unknown>;
  try {
    const { payload: verified } = await jwtVerify(idToken, createLocalJWKSet(snapshot.jwks), {
      issuer: cfg.issuer,
      audience: cfg.clientId,
      algorithms: ALLOWED_ALGS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    claims = verified as Record<string, unknown>;
  } catch (e) {
    return fail('bad_signature', e instanceof Error ? e.message : 'проверка подписи не прошла');
  }

  // nonce привязывает удостоверение к НАШЕМУ редиректу: без него принятый
  // id_token, добытый в чужой сессии, подошёл бы и здесь.
  if (claims.nonce !== expectedNonce) {
    return fail('nonce_mismatch', 'nonce не совпал');
  }

  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  if (!subject) return fail('subject_missing', 'в id_token нет sub');

  return {
    ok: true,
    claims: {
      subject,
      email: typeof claims.email === 'string' ? claims.email : null,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' ? claims.name : null,
    },
  };
}
