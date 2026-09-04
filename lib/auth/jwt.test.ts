import { describe, expect, it } from 'vitest';
import {
  signOidcConfirm,
  signOidcState,
  signSession,
  signTotpPending,
  verifyOidcConfirm,
  verifyOidcState,
  verifySession,
  verifySessionPayload,
  verifyTotpPending,
} from './jwt';

/**
 * Регрессия на обход второго фактора (найден адверсариальным разбором 2026-09-04).
 *
 * Все токены входа подписаны ОДНИМ ключом, поэтому подпись сама по себе не
 * говорит, чем токен является. Промежуточный токен второго фактора несёт тот же
 * `uid`, что и сессия, — и до этой правки его хватало переложить из cookie
 * `karman_totp_pending` в `karman_session_v2`, чтобы войти без TOTP-кода.
 */

// Ключ подписи здесь НЕ задаётся: вне production `getSecretKey()` берёт его из
// собственного dev-fallback'а, а подписывает и проверяет один и тот же процесс,
// поэтому round-trip замкнут при любом окружении запуска. Первая редакция теста
// присваивала `process.env.SESSION_SECRET` литерал — и была справедливо
// остановлена секрет-сканером в CI (правило karman-env-secrets): присвоение
// секрета строкой в отслеживаемом файле выглядит одинаково и в тесте, и в бою.

describe('verifySessionPayload', () => {
  it('принимает настоящую сессию', async () => {
    const token = await signSession(42, false);
    expect(await verifySessionPayload(token)).toEqual({ uid: 42, mfa: false });
  });

  it('сохраняет отметку пройденного второго фактора', async () => {
    const token = await signSession(42, true);
    expect(await verifySessionPayload(token)).toEqual({ uid: 42, mfa: true });
  });

  it('НЕ принимает промежуточный токен второго фактора как сессию', async () => {
    // Ровно этот подлог и был дырой: пароль принят, TOTP не спрошен, а cookie
    // переложена руками.
    const pending = await signTotpPending(42);
    expect(await verifySessionPayload(pending)).toBeNull();
    expect(await verifySession(pending)).toBeNull();
  });

  it('промежуточный токен при этом остаётся годным по своему назначению', async () => {
    // Правка не должна ломать сам второй шаг входа.
    const pending = await signTotpPending(42);
    expect(await verifyTotpPending(pending)).toBe(42);
  });

  it('сессия не принимается вместо промежуточного токена', async () => {
    expect(await verifyTotpPending(await signSession(42))).toBeNull();
  });

  it('мусор и пустое отвергаются', async () => {
    expect(await verifySessionPayload(null)).toBeNull();
    expect(await verifySessionPayload(undefined)).toBeNull();
    expect(await verifySessionPayload('не.токен.вовсе')).toBeNull();
  });
});

/**
 * Режим потока ЕСА. Привязка отличается от входа ровно одним полем, и это поле
 * обязано быть ПОДПИСАННЫМ: иначе начатый кем-то вход дописывает себе `link`,
 * и возврат привязывает чужую личность к той сессии, что окажется в браузере.
 */
describe('verifyOidcState — режим и адресат', () => {
  const base = { state: 's', nonce: 'n', codeVerifier: 'v' };

  it('вход разбирается как login', async () => {
    const got = await verifyOidcState(await signOidcState({ ...base, mode: 'login' }));
    expect(got?.mode).toBe('login');
    expect(got?.uid).toBeUndefined();
  });

  it('привязка несёт uid', async () => {
    const got = await verifyOidcState(await signOidcState({ ...base, mode: 'link', uid: 42 }));
    expect(got?.mode).toBe('link');
    expect(got?.uid).toBe(42);
  });

  it('link без uid отвергается целиком', async () => {
    // Привязывать «к кому-нибудь» нельзя: адресат обязан быть назван заранее.
    const forged = await signOidcState({ ...base, mode: 'link' } as never);
    expect(await verifyOidcState(forged)).toBeNull();
  });

  it('cookie без режима доигрывает как ВХОД, а не как привязка', async () => {
    // Выписанные до этой правки состояния обязаны остаться входами: привязка
    // требует явного 'link'. Иначе выкатка молча превратила бы чужие потоки
    // в привязки.
    const legacy = await signOidcState(base as never);
    const got = await verifyOidcState(legacy);
    expect(got?.mode).toBe('login');
  });

  it('чужая подпись не проходит', async () => {
    expect(await verifyOidcState('явно.не.жетон')).toBeNull();
  });
});

describe('verifyOidcConfirm', () => {
  it('возвращает то, что подписали', async () => {
    const token = await signOidcConfirm({
      uid: 7,
      issuer: 'https://esa.example',
      subject: 'vk-1',
      email: 'a@b.c',
      name: 'Имя',
    });
    const got = await verifyOidcConfirm(token);
    expect(got).toMatchObject({ uid: 7, subject: 'vk-1', email: 'a@b.c' });
  });

  it('токен состояния не принимается как подтверждение', async () => {
    // Разные stage — разные полномочия: состояние редиректа не должно
    // сходить за уже проверенный результат.
    const state = await signOidcState({ state: 's', nonce: 'n', codeVerifier: 'v', mode: 'login' });
    expect(await verifyOidcConfirm(state)).toBeNull();
  });
});
