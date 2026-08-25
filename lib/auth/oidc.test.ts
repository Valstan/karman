import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAuthorizeUrl, codeChallenge, esaConfig, newAuthRequest } from './oidc-pkce';
import { esaRedirectUri } from './oidc-redirect';

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

describe('buildAuthorizeUrl', () => {
  const endpoints = {
    authorizationEndpoint: 'https://esa.example/oidc/authorize',
    tokenEndpoint: 'https://esa.example/oidc/token',
    jwksUri: 'https://esa.example/.well-known/jwks.json',
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
