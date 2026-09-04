import { SignJWT, jwtVerify } from 'jose';

/**
 * Подпись/проверка сессионного JWT (HS256). Чистый jose — Edge-safe,
 * используется и в middleware, и в Node-роутах. Без БД и next/headers.
 */

/**
 * Имена cookie несут префикс `__Host-` (2026-09-04).
 *
 * Причина конкретная, не гигиеническая: КАРМАН живёт на `карман.вмалмыже.рф`,
 * а ЕСА — на `вход.вмалмыже.рф`, то есть это СОСЕДИ под одним `вмалмыже.рф`.
 * Любой сосед (свой, захваченный или с XSS) вправе выставить cookie с
 * `Domain=.вмалмыже.рф`, и она приедет к нам под тем же именем. При двух
 * cookie с одним именем побеждает та, что пришла в заголовке позже, — то есть
 * подброшенная. Префикс `__Host-` браузер запрещает ставить вместе с `Domain`,
 * поэтому подбросить cookie с таким именем сосед физически не может.
 *
 * До появления кнопки привязки подмена сессии была обратимой (перелогинился —
 * и всё). С привязкой она становится НЕОБРАТИМОЙ: человек, сидящий в
 * подброшенной чужой сессии, отдаёт свою личность ЕСА в чужой аккаунт навсегда.
 *
 * Старое имя ещё ЧИТАЕТСЯ (`SESSION_COOKIE_LEGACY`), но больше не пишется —
 * иначе переименование разлогинило бы всех разом. Через `SESSION_TTL_SECONDS`
 * (14 дней) все живые сессии переедут сами, и легаси-имя можно убирать.
 */
export const SESSION_COOKIE = '__Host-karman_session_v2';
export const SESSION_COOKIE_LEGACY = 'karman_session_v2';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 дней

const DEV_FALLBACK_SECRET = 'dev-insecure-secret-change-me';

let cachedKey: Uint8Array | null = null;

/**
 * Ленивый резолв ключа подписи. Проверка обязательного секрета отложена до
 * первого использования (а не на момент вычисления модуля): `next build`
 * импортирует роуты на этапе «Collecting page data» с NODE_ENV=production,
 * и top-level throw ломал бы сборку прод-артефакта без рантайм-секрета.
 * Fail-fast в production сохраняется — первый же запрос к защищённому
 * маршруту упадёт, если SESSION_SECRET не задан (см. также instrumentation.ts,
 * который валидирует секрет на старте сервера). См. план, раздел «Безопасность».
 */
function getSecretKey(): Uint8Array {
  if (cachedKey) {
    return cachedKey;
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production');
  }
  cachedKey = new TextEncoder().encode(secret || DEV_FALLBACK_SECRET);
  return cachedKey;
}

/** mfa — сессия прошла второй фактор (TOTP/recovery); гейт раздела /secrets. */
export async function signSession(uid: number, mfa = false): Promise<string> {
  return new SignJWT({ uid, mfa })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

export type SessionPayload = { uid: number; mfa: boolean };

export async function verifySessionPayload(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (typeof payload.uid !== 'number') return null;
    // Токен ЭТАПА входа не является сессией. Промежуточный токен второго
    // фактора (`signTotpPending`) подписан ТЕМ ЖЕ ключом и несёт тот же `uid`,
    // поэтому без этой проверки его достаточно переложить из cookie
    // `karman_totp_pending` в `karman_session_v2` — и второй фактор обойдён:
    // пароль уже принят, а TOTP-код спрашивать больше некому.
    //
    // Проверяется НАЛИЧИЕ метки, а не её значение: сессионный токен метки не
    // несёт вовсе, поэтому уже выданные сессии остаются рабочими (иначе правка
    // разлогинила бы всех), а любой будущий этапный токен отсекается сам —
    // даже если про эту функцию забудут.
    if (payload.stage !== undefined) return null;
    return { uid: payload.uid, mfa: payload.mfa === true };
  } catch {
    return null;
  }
}

export async function verifySession(token: string | undefined | null): Promise<number | null> {
  return (await verifySessionPayload(token))?.uid ?? null;
}

// --- Промежуточный токен второго шага входа (пароль принят, ждём TOTP-код) ---

export const TOTP_PENDING_COOKIE = '__Host-karman_totp_pending';
export const TOTP_PENDING_COOKIE_LEGACY = 'karman_totp_pending';
export const TOTP_PENDING_TTL_SECONDS = 5 * 60;

export async function signTotpPending(uid: number): Promise<string> {
  return new SignJWT({ uid, stage: 'totp' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TOTP_PENDING_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifyTotpPending(token: string | undefined | null): Promise<number | null> {
  if (!token) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    return payload.stage === 'totp' && typeof payload.uid === 'number' ? payload.uid : null;
  } catch {
    return null;
  }
}

// --- Состояние браузерного редиректа ЕСА (OIDC state + nonce + PKCE) ---------

export const OIDC_STATE_COOKIE = '__Host-karman_oidc_state';
/** Пользователь должен успеть пройти чужую форму входа; дольше держать незачем. */
export const OIDC_STATE_TTL_SECONDS = 10 * 60;

/**
 * `mode` и `uid` лежат ВНУТРИ подписанного токена, а не в query-параметре.
 *
 * Иначе режим подменяется тривиально: начатый кем-то вход дописал бы себе
 * `mode=link`, и возврат привязал бы чужую личность к той сессии, что окажется
 * в браузере. Подпись делает режим и адресата решением ТОГО, кто начал поток.
 *
 * `uid` заполняется только у `link` и сверяется на возврате с живой сессией:
 * если человек за время похода в ЕСА вышел или вошёл другим, привязки не будет.
 */
export type OidcStatePayload = {
  state: string;
  nonce: string;
  codeVerifier: string;
  mode: 'login' | 'link';
  uid?: number;
};

/**
 * Состояние редиректа едет в подписанной cookie, а не в таблице.
 *
 * Причина не в экономии: строка в БД пережила бы рестарт, но потребовала бы
 * чистки протухших и дала бы ещё одну поверхность, где висит `code_verifier`.
 * Подписанная кука привязана к браузеру, который начал вход, гаснет сама по
 * сроку и удаляется в момент обмена — то есть одноразова по построению.
 */
export async function signOidcState(payload: OidcStatePayload): Promise<string> {
  return new SignJWT({ ...payload, stage: 'oidc' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${OIDC_STATE_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifyOidcState(
  token: string | undefined | null,
): Promise<OidcStatePayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (payload.stage !== 'oidc') return null;
    const { state, nonce, codeVerifier, mode, uid } = payload as Record<string, unknown>;
    if (typeof state !== 'string' || typeof nonce !== 'string' || typeof codeVerifier !== 'string') {
      return null;
    }
    // Режим по умолчанию — вход: cookie, выписанная до этой правки, обязана
    // доиграть как обычный вход, а не как привязка. Неизвестное значение тоже
    // считаем входом: привязка требует ЯВНОГО 'link'.
    const parsedMode = mode === 'link' ? 'link' : 'login';
    if (parsedMode === 'link' && typeof uid !== 'number') return null;
    return {
      state,
      nonce,
      codeVerifier,
      mode: parsedMode,
      ...(parsedMode === 'link' ? { uid: uid as number } : {}),
    };
  } catch {
    return null;
  }
}

// --- Подтверждение привязки личности ЕСА -------------------------------------

export const OIDC_CONFIRM_COOKIE = '__Host-karman_oidc_confirm';
/** Человеку нужно прочитать одну фразу и нажать кнопку; дольше держать незачем. */
export const OIDC_CONFIRM_TTL_SECONDS = 3 * 60;

export type OidcConfirmPayload = {
  uid: number;
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
};

/**
 * Привязка НЕ совершается в момент возврата из ЕСА — сначала человек видит,
 * ЧЬЯ личность вернулась, и подтверждает.
 *
 * Это страховка, не зависящая от добросовестности провайдера. Запрос на
 * привязку уходит с `prompt=login`, то есть ЕСА обязан переспросить человека;
 * но если он этого не сделает (не поддерживает, игнорирует, скомпрометирован),
 * вернётся та личность, что уже сидит в браузере. Подложи туда кто-нибудь свою
 * сессию ЕСА — и человек, нажав «Привязать», отдал бы свой аккаунт: чужой ключ
 * от своей двери, причём молча. Экран подтверждения делает подмену видимой:
 * привязывается не «то, что вернулось», а то, что человек прочитал глазами.
 */
export async function signOidcConfirm(payload: OidcConfirmPayload): Promise<string> {
  return new SignJWT({ ...payload, stage: 'oidc_confirm' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${OIDC_CONFIRM_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifyOidcConfirm(
  token: string | undefined | null,
): Promise<OidcConfirmPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (payload.stage !== 'oidc_confirm') return null;
    const { uid, issuer, subject, email, name } = payload as Record<string, unknown>;
    if (typeof uid !== 'number' || typeof issuer !== 'string' || typeof subject !== 'string') {
      return null;
    }
    return {
      uid,
      issuer,
      subject,
      email: typeof email === 'string' ? email : null,
      name: typeof name === 'string' ? name : null,
    };
  } catch {
    return null;
  }
}
