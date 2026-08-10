import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';

/**
 * Верификатор паспортного удостоверения (ADR-0012 мозга, волна 2).
 *
 * Fail-closed: любая неопределённость — отказ. Набор проверок задан адверсариальной
 * проверкой ADR-0012 §5 и не является набором рекомендаций:
 *   - allowlist алгоритма подписи с ОБЯЗАТЕЛЬНЫМ `kid` (без него подбор ключа
 *     превращается в «любой ключ из набора подойдёт»);
 *   - явные `maxTokenAge` и `clockTolerance` (по умолчанию jose их не ставит);
 *   - `iss`/`aud` — ровно из строки реестра issuer'ов, не из самого токена;
 *   - пин субъекта регэкспом issuer'а: ветки, PR и форки личность НЕ минтят;
 *   - отказ раннерам вне доверенного окружения (`runner_environment`);
 *   - обязательный `jti` — без него одноразовость удостоверения недостижима.
 *
 * Чистый модуль (без `server-only`, без БД и сети): ключи и конфиг приходят
 * аргументами, одноразовость `jti` и карта личностей — уровнем выше
 * (`lib/services/passport.ts`). Так проверка юнит-тестируется целиком.
 */

/** Строка реестра доверенных issuer'ов — ровно те поля, что участвуют в проверке. */
export type IssuerConfig = {
  issuer: string;
  audience: string;
  /** Регэксп по `sub`; компилируется здесь, невалидный — отказ, а не исключение. */
  subjectPattern: string;
  /** Claim с неизменяемым числовым идентификатором личности (GitHub — `repository_id`). */
  identityClaim: string;
};

/**
 * Принципал — ТИП, а не булев гейт (ADR-0012 §2): добавление собственного
 * issuer'а не меняет ни одного потребителя. `ci` — единственный настроенный
 * акцептор волны 2; `domain`/`root` появятся своими акцепторами.
 */
export type Principal = {
  kind: 'ci';
  /** Значение identity_claim как строка — по нему ищется строка реестра личностей. */
  identityValue: string;
  subject: string;
  jti: string;
  /** exp удостоверения (мс) — по нему живёт запись anti-replay. */
  expiresAtMs: number;
};

export type VerifyFailure = {
  ok: false;
  /** Короткий код для аудита — в ответ клиенту уходит общая формулировка. */
  reason:
    | 'malformed'
    | 'alg_not_allowed'
    | 'kid_missing'
    | 'bad_signature'
    | 'issuer_pattern_invalid'
    | 'subject_not_allowed'
    | 'runner_untrusted'
    | 'jti_missing'
    | 'identity_claim_missing'
    | 'exp_missing';
  detail: string;
};

export type VerifyResult = { ok: true; principal: Principal } | VerifyFailure;

/**
 * Асимметричные подписи только: HS* принял бы за ключ ЛЮБУЮ строку из JWKS,
 * то есть публичный ключ стал бы секретом подписи (классическая подмена alg).
 */
const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384'] as const;

/** Удостоверение старше — не принимается, даже если `exp` ещё не наступил. */
const MAX_TOKEN_AGE_SECONDS = 300;
/** Расхождение часов бокса и issuer'а, допустимое в обе стороны. */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Доверенные окружения раннера. `self-hosted` отвергается: раннер на чужой
 * машине выпускает удостоверение под подпись GitHub, но исполняется вне
 * периметра, которому мы доверяем (ADR-0012 §5).
 */
const TRUSTED_RUNNER_ENVIRONMENTS = new Set(['github-hosted']);

function fail(reason: VerifyFailure['reason'], detail: string): VerifyFailure {
  return { ok: false, reason, detail };
}

/**
 * Проверяет удостоверение против строки реестра issuer'ов и снимка JWKS.
 * Снимок передаётся аргументом (кто и когда его обновлял — забота `jwks.ts`),
 * поэтому проверка подписи не ходит в сеть и не зависит от доступности issuer'а.
 */
export async function verifyAssertion(
  rawJwt: string,
  issuer: IssuerConfig,
  jwks: JSONWebKeySet,
  now: Date = new Date(),
): Promise<VerifyResult> {
  // Регэксп из БД: невалидный шаблон = отказ всем, а не исключение в роуте.
  let subjectRe: RegExp;
  try {
    subjectRe = new RegExp(issuer.subjectPattern);
  } catch {
    return fail('issuer_pattern_invalid', `невалидный subject_pattern issuer'а ${issuer.issuer}`);
  }

  // Заголовок разбираем ДО проверки подписи: `kid` обязателен, и отказ по
  // алгоритму должен быть отличим в аудите от отказа по подписи.
  let header;
  try {
    header = decodeProtectedHeader(rawJwt);
  } catch {
    return fail('malformed', 'удостоверение не разбирается как JWT');
  }
  if (!header.alg || !(ALLOWED_ALGS as readonly string[]).includes(header.alg)) {
    return fail('alg_not_allowed', `алгоритм ${header.alg ?? '—'} вне allowlist`);
  }
  if (!header.kid) {
    return fail('kid_missing', 'в заголовке нет kid');
  }

  let payload;
  try {
    const verified = await jwtVerify(rawJwt, createLocalJWKSet(jwks), {
      issuer: issuer.issuer,
      audience: issuer.audience,
      algorithms: [...ALLOWED_ALGS],
      maxTokenAge: MAX_TOKEN_AGE_SECONDS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
    });
    payload = verified.payload;
  } catch (e) {
    // Причину наружу не раскрываем: истёк / чужой aud / чужая подпись для
    // предъявителя неразличимы, в аудит уходит текст jose.
    return fail('bad_signature', e instanceof Error ? e.message : 'подпись не проверена');
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  if (!subject || !subjectRe.test(subject)) {
    return fail('subject_not_allowed', `sub=${subject || '—'} не проходит пин субъекта`);
  }

  // Claim присутствует не у всех issuer'ов; если пришёл — обязан быть доверенным.
  const runner = payload.runner_environment;
  if (runner !== undefined && (typeof runner !== 'string' || !TRUSTED_RUNNER_ENVIRONMENTS.has(runner))) {
    return fail('runner_untrusted', `runner_environment=${String(runner)}`);
  }

  if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
    return fail('jti_missing', 'в удостоверении нет jti — одноразовость недостижима');
  }
  if (typeof payload.exp !== 'number') {
    return fail('exp_missing', 'в удостоверении нет exp');
  }

  // Личность — строкой: числовой id репозитория у GitHub приходит числом,
  // сравнение с реестром идёт по строковому представлению.
  const claim = payload[issuer.identityClaim];
  const identityValue =
    typeof claim === 'string' ? claim : typeof claim === 'number' ? String(claim) : '';
  if (!identityValue) {
    return fail('identity_claim_missing', `в удостоверении нет claim ${issuer.identityClaim}`);
  }

  return {
    ok: true,
    principal: {
      kind: 'ci',
      identityValue,
      subject,
      jti: payload.jti,
      expiresAtMs: payload.exp * 1000,
    },
  };
}
