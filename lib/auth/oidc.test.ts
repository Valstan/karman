import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildAuthorizeUrl,
  codeChallenge,
  esaConfig,
  mergeUserinfo,
  newAuthRequest,
  pickUserinfoEndpoint,
  userinfoNeeded,
} from './oidc-pkce';
import type { OidcClaims } from './oidc-pkce';
import { appUrl, esaRedirectUri } from './oidc-redirect';

/**
 * Тесты чистой части входа через ЕСА. Сетевые куски (discovery, обмен кода,
 * проверка подписи) требуют живого провайдера и снимка JWKS — они проверяются
 * сквозным прогоном, а не здесь.
 */

const ENV_KEYS = ['ESA_ISSUER', 'ESA_CLIENT_ID', 'ESA_CLIENT_SECRET', 'ESA_REDIRECT_URI'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('PKCE', () => {
  it('S256-преобразование совпадает с контрольным вектором RFC 7636', () => {
    // Приложение B RFC 7636. Своя реализация обязана совпасть с эталоном,
    // иначе провайдер отвергнет обмен, а сообщение будет невнятным.
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('verifier укладывается в допустимую длину и алфавит RFC 7636', () => {
    const req = newAuthRequest();
    expect(req.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(req.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(req.codeVerifier).toMatch(/^[A-Za-z0-9._~-]+$/);
  });

  it('state, nonce и verifier каждый раз разные и не совпадают между собой', () => {
    const a = newAuthRequest();
    const b = newAuthRequest();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    // Одна величина на все три роли означала бы, что знание state даёт verifier.
    expect(new Set([a.state, a.nonce, a.codeVerifier]).size).toBe(3);
  });
});

describe('esaConfig', () => {
  it('без полной конфигурации возвращает null (кнопку не показываем)', () => {
    expect(esaConfig()).toBeNull();
    process.env.ESA_ISSUER = 'https://esa.example';
    expect(esaConfig()).toBeNull();
    process.env.ESA_CLIENT_ID = 'karman';
    expect(esaConfig()).toBeNull();
  });

  it('при полной конфигурации возвращает её', () => {
    process.env.ESA_ISSUER = 'https://esa.example';
    process.env.ESA_CLIENT_ID = 'karman';
    process.env.ESA_CLIENT_SECRET = 's3cret';
    expect(esaConfig()).toEqual({
      issuer: 'https://esa.example',
      clientId: 'karman',
      clientSecret: 's3cret',
    });
  });
});

describe('esaRedirectUri', () => {
  it('http на публичном хосте отвергается', () => {
    process.env.ESA_REDIRECT_URI = 'http://example.org/api/auth/oidc/callback';
    expect(esaRedirectUri()).toBeNull();
  });

  it('http на localhost допустим (локальная разработка)', () => {
    process.env.ESA_REDIRECT_URI = 'http://localhost:3000/api/auth/oidc/callback';
    expect(esaRedirectUri()).toBe('http://localhost:3000/api/auth/oidc/callback');
  });

  it('https принимается, мусор — нет', () => {
    process.env.ESA_REDIRECT_URI = 'https://example.org/api/auth/oidc/callback';
    expect(esaRedirectUri()).toBe('https://example.org/api/auth/oidc/callback');
    process.env.ESA_REDIRECT_URI = 'не-url';
    expect(esaRedirectUri()).toBeNull();
  });
});

describe('appUrl — редиректы не зависят от адреса, на котором слушает сервер', () => {
  const req = { url: 'http://localhost:3002/api/auth/oidc/callback?code=x' };

  it('origin берётся из ESA_REDIRECT_URI, путь и query — из аргумента', () => {
    process.env.ESA_REDIRECT_URI = 'https://example.org/api/auth/oidc/callback';
    expect(appUrl('/login?esa=not_invited', req).toString()).toBe(
      'https://example.org/login?esa=not_invited',
    );
  });

  it('без ESA_REDIRECT_URI — прежнее поведение от req.url', () => {
    delete process.env.ESA_REDIRECT_URI;
    expect(appUrl('/login?esa=off', req).toString()).toBe('http://localhost:3002/login?esa=off');
  });
});

describe('buildAuthorizeUrl', () => {
  const endpoints = {
    authorizationEndpoint: 'https://esa.example/oidc/authorize',
    tokenEndpoint: 'https://esa.example/oidc/token',
    jwksUri: 'https://esa.example/.well-known/jwks.json',
    userinfoEndpoint: 'https://esa.example/oidc/userinfo',
  };
  const cfg = { issuer: 'https://esa.example', clientId: 'karman', clientSecret: 's3cret' };

  it('несёт все обязательные параметры и именно S256', () => {
    const req = newAuthRequest();
    const url = new URL(
      buildAuthorizeUrl(endpoints, cfg, req, 'https://app.example/api/auth/oidc/callback'),
    );
    expect(url.origin + url.pathname).toBe('https://esa.example/oidc/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('karman');
    expect(url.searchParams.get('state')).toBe(req.state);
    expect(url.searchParams.get('nonce')).toBe(req.nonce);
    // plain здесь означал бы PKCE без защиты: перехватчик кода перехватил бы и verifier.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(codeChallenge(req.codeVerifier));
  });

  it('code_verifier в адресную строку НЕ попадает', () => {
    const req = newAuthRequest();
    const raw = buildAuthorizeUrl(endpoints, cfg, req, 'https://app.example/api/auth/oidc/callback');
    // Утечка verifier'а в URL обнуляет весь смысл PKCE.
    expect(raw).not.toContain(req.codeVerifier);
  });

  it('redirect_uri передаётся байт-в-байт, включая punycode', () => {
    const req = newAuthRequest();
    const redirect = 'https://xn--80aa2ajgp.xn--80adkdyec4j.xn--p1ai/api/auth/oidc/callback';
    const url = new URL(buildAuthorizeUrl(endpoints, cfg, req, redirect));
    // Провайдер сверяет со списком точным сравнением: любая нормализация здесь
    // означает отказ «invalid redirect_uri» без внятного объяснения.
    expect(url.searchParams.get('redirect_uri')).toBe(redirect);
  });
});

/**
 * userinfo. Сам сетевой вызов живёт в `oidc.ts` (там `server-only`, в vitest он
 * бросает при импорте), поэтому все решения вынесены сюда чистыми функциями —
 * иначе они остались бы без гейта вовсе.
 */
describe('pickUserinfoEndpoint', () => {
  const issuer = 'https://esa.example';

  it('берёт адрес того же хоста по https', () => {
    expect(pickUserinfoEndpoint({ userinfo_endpoint: 'https://esa.example/oidc/userinfo' }, issuer))
      .toBe('https://esa.example/oidc/userinfo');
  });

  it('нет поля — null, а не отказ входа', () => {
    // Провайдер без userinfo обязан пускать по-прежнему.
    expect(pickUserinfoEndpoint({}, issuer)).toBeNull();
  });

  it('чужой хост отвергается', () => {
    // Туда уехал бы живой access_token — то есть доступ к профилю достался бы
    // тому, кого мы не спрашивали.
    expect(pickUserinfoEndpoint({ userinfo_endpoint: 'https://evil.example/userinfo' }, issuer))
      .toBeNull();
  });

  it('http отвергается даже на своём хосте', () => {
    expect(pickUserinfoEndpoint({ userinfo_endpoint: 'http://esa.example/oidc/userinfo' }, issuer))
      .toBeNull();
  });
});

describe('userinfoNeeded', () => {
  const full: OidcClaims = { subject: 's', email: 'a@b.c', emailVerified: true, name: 'Имя' };

  it('id_token дал всё — в сеть не идём', () => {
    expect(userinfoNeeded(full)).toBe(false);
  });

  it('почты нет — идём', () => {
    expect(userinfoNeeded({ ...full, email: null })).toBe(true);
  });

  it('почта есть, но не подтверждена — идём: привязка стоит на подтверждении', () => {
    expect(userinfoNeeded({ ...full, emailVerified: false })).toBe(true);
  });
});

describe('mergeUserinfo', () => {
  const base: OidcClaims = { subject: 'sub-1', email: null, emailVerified: false, name: null };

  it('заполняет пустую почту и подтверждение', () => {
    const r = mergeUserinfo(base, { sub: 'sub-1', email: 'v@valstan.ru', email_verified: true });
    expect(r.outcome).toBe('ok_filled');
    expect(r.claims.email).toBe('v@valstan.ru');
    expect(r.claims.emailVerified).toBe(true);
  });

  it('чужой sub отбрасывает ответ ЦЕЛИКОМ', () => {
    // OIDC Core 5.3.2. Иначе чужой профиль привязал бы чужую почту к входу.
    const r = mergeUserinfo(base, { sub: 'sub-2', email: 'evil@example.com', email_verified: true });
    expect(r.outcome).toBe('sub_mismatch');
    expect(r.claims.email).toBeNull();
  });

  it('не переопределяет то, что пришло подписанным в id_token', () => {
    const signed: OidcClaims = { ...base, email: 'real@valstan.ru', emailVerified: true };
    const r = mergeUserinfo(signed, { sub: 'sub-1', email: 'other@example.com', email_verified: true });
    // Ответ userinfo не подписан — разреши он подмену, это была бы подмена личности.
    expect(r.claims.email).toBe('real@valstan.ru');
  });

  it('email_verified строкой "true" не считается подтверждением', () => {
    const r = mergeUserinfo(base, { sub: 'sub-1', email: 'v@valstan.ru', email_verified: 'true' });
    expect(r.claims.emailVerified).toBe(false);
  });

  it('почта без @ и слишком длинная не берутся', () => {
    expect(mergeUserinfo(base, { sub: 'sub-1', email: 'нетсобаки' }).claims.email).toBeNull();
    const long = 'a'.repeat(250) + '@b.cc';
    // Колонка auth_oidc_identity.email — varchar(254): иначе INSERT упал бы уже
    // ПОСЛЕ успешной проверки подписи.
    expect(mergeUserinfo(base, { sub: 'sub-1', email: long }).claims.email).toBeNull();
  });

  it('ответ без новых полей помечается отдельно', () => {
    const r = mergeUserinfo({ ...base, email: 'a@b.c', emailVerified: true, name: 'Имя' }, { sub: 'sub-1' });
    expect(r.outcome).toBe('ok_nothing_new');
  });
});

describe('buildAuthorizeUrl — режим привязки', () => {
  const endpoints = {
    authorizationEndpoint: 'https://esa.example/oidc/authorize',
    tokenEndpoint: 'https://esa.example/oidc/token',
    jwksUri: 'https://esa.example/.well-known/jwks.json',
    userinfoEndpoint: 'https://esa.example/oidc/userinfo',
  };
  const cfg = { issuer: 'https://esa.example', clientId: 'karman', clientSecret: 's3cret' };
  const redirect = 'https://app.example/api/auth/oidc/callback';

  it('привязка требует переспросить человека', () => {
    // Без prompt=login провайдер молча вернёт личность, уже сидящую в браузере,
    // и человек привяжет к себе чужой аккаунт.
    const url = new URL(buildAuthorizeUrl(endpoints, cfg, newAuthRequest(), redirect, 'link'));
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
  });

  it('вход НЕ требует — иначе единый вход перестал бы быть единым', () => {
    const url = new URL(buildAuthorizeUrl(endpoints, cfg, newAuthRequest(), redirect, 'login'));
    expect(url.searchParams.get('prompt')).toBeNull();
  });

  it('по умолчанию это вход', () => {
    const url = new URL(buildAuthorizeUrl(endpoints, cfg, newAuthRequest(), redirect));
    expect(url.searchParams.get('prompt')).toBeNull();
  });
});
