import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_TTL_DEFAULT_MINUTES,
  BOOTSTRAP_TTL_MAX_MINUTES,
  BOOTSTRAP_TTL_MIN_MINUTES,
  clampTtlMinutes,
  generateBootstrapCode,
  hashBootstrapCode,
  looksLikeBootstrapCode,
} from './bootstrap-code';

describe('generateBootstrapCode', () => {
  it('даёт префикс skb_ — класс строки виден по первым символам, без обращения к БД', () => {
    const c = generateBootstrapCode();
    expect(c.code.startsWith('skb_')).toBe(true);
    expect(c.prefix).toBe(c.code.slice(0, 12));
  });

  it('в БД уходит только хэш, и он совпадает с хэшем самого кода', () => {
    const c = generateBootstrapCode();
    expect(c.hash).toBe(hashBootstrapCode(c.code));
    expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
    // Сам код в хэше не восстановим — проверяем хотя бы, что он не подстрока.
    expect(c.hash.includes(c.code.slice(4))).toBe(false);
  });

  it('не повторяется', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateBootstrapCode().code));
    expect(codes.size).toBe(200);
  });
});

describe('looksLikeBootstrapCode', () => {
  it('отсеивает рабочий токен комнаты — это разные классы строк', () => {
    expect(looksLikeBootstrapCode('skm_AbCdEfGhIjKlMnOpQrStUvWxYz012345')).toBe(false);
  });

  it('отсеивает мусор и обрубки', () => {
    expect(looksLikeBootstrapCode('')).toBe(false);
    expect(looksLikeBootstrapCode('skb_')).toBe(false);
    expect(looksLikeBootstrapCode('skb_short')).toBe(false);
    expect(looksLikeBootstrapCode('не-код-вовсе')).toBe(false);
  });

  it('принимает настоящий код', () => {
    expect(looksLikeBootstrapCode(generateBootstrapCode().code)).toBe(true);
  });
});

describe('clampTtlMinutes', () => {
  it('оставляет значение из допустимого диапазона', () => {
    expect(clampTtlMinutes(30)).toBe(30);
    expect(clampTtlMinutes(BOOTSTRAP_TTL_MIN_MINUTES)).toBe(BOOTSTRAP_TTL_MIN_MINUTES);
    expect(clampTtlMinutes(BOOTSTRAP_TTL_MAX_MINUTES)).toBe(BOOTSTRAP_TTL_MAX_MINUTES);
  });

  it('зажимает выход за границы, а не падает', () => {
    expect(clampTtlMinutes(1)).toBe(BOOTSTRAP_TTL_MIN_MINUTES);
    expect(clampTtlMinutes(100000)).toBe(BOOTSTRAP_TTL_MAX_MINUTES);
    expect(clampTtlMinutes(-5)).toBe(BOOTSTRAP_TTL_MIN_MINUTES);
  });

  it('мусор сводит к дефолту (форма могла прислать пустую строку)', () => {
    expect(clampTtlMinutes(Number.NaN)).toBe(BOOTSTRAP_TTL_DEFAULT_MINUTES);
    expect(clampTtlMinutes(Number.POSITIVE_INFINITY)).toBe(BOOTSTRAP_TTL_DEFAULT_MINUTES);
  });

  it('дробное усекает (30.9 минут — это 30, а не 31)', () => {
    expect(clampTtlMinutes(30.9)).toBe(30);
  });
});
