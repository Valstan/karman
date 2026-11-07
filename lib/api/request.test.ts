import { describe, expect, it } from 'vitest';
import { bearerToken } from './request';

/**
 * Контроль к R2 (Q3-самоосмотр 2026-08-10): контракт разбора `Authorization`
 * живёт в одном файле и покрыт тестом, а не размазан по пяти роутов.
 *
 * Тест закрепляет поведение, которое было у всех пяти копий одинаковым, —
 * перенос не должен был изменить ни одного края (включая нечётные).
 */
function request(headers: Record<string, string>): Request {
  return new Request('https://example.test/api/secrets', { headers });
}

describe('bearerToken', () => {
  it('берёт токен из `Authorization: Bearer …`', () => {
    expect(bearerToken(request({ authorization: 'Bearer skm_secret' }))).toBe('skm_secret');
  });

  it('схема нечувствительна к регистру', () => {
    expect(bearerToken(request({ authorization: 'bearer skm_secret' }))).toBe('skm_secret');
    expect(bearerToken(request({ authorization: 'BEARER skm_secret' }))).toBe('skm_secret');
    expect(bearerToken(request({ authorization: 'BeArEr skm_secret' }))).toBe('skm_secret');
  });

  it('лишние пробелы между схемой и токеном и вокруг токена не важны', () => {
    expect(bearerToken(request({ authorization: 'Bearer   skm_secret' }))).toBe('skm_secret');
    expect(bearerToken(request({ authorization: 'Bearer \t skm_secret ' }))).toBe('skm_secret');
    expect(bearerToken(request({ authorization: '  Bearer skm_secret  ' }))).toBe('skm_secret');
  });

  it('нет заголовка, пустой заголовок, нет токена — null', () => {
    expect(bearerToken(request({}))).toBeNull();
    expect(bearerToken(request({ authorization: '' }))).toBeNull();
    expect(bearerToken(request({ authorization: 'Bearer' }))).toBeNull();
    expect(bearerToken(request({ authorization: 'Bearer   ' }))).toBeNull();
  });

  it('чужая схема — null, а не токен', () => {
    expect(bearerToken(request({ authorization: 'Basic skm_secret' }))).toBeNull();
    expect(bearerToken(request({ authorization: 'skm_secret' }))).toBeNull();
    expect(bearerToken(request({ authorization: 'Bearerish skm_secret' }))).toBeNull();
  });

  it('значение после схемы берётся как есть: пробел внутри — часть токена, а не обход', () => {
    // Такой токен не совпадёт ни с одной комнатой — приходит 401.
    expect(bearerToken(request({ authorization: 'Bearer skm_secret extra' }))).toBe(
      'skm_secret extra',
    );
  });
});
