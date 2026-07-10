import { describe, it, expect } from 'vitest';
import { generateSync } from 'otplib';
import {
  generateTotpSecret,
  totpKeyUri,
  verifyTotpCode,
  totpAad,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  looksLikeRecoveryCode,
} from './totp';

describe('totp', () => {
  it('сгенерированный секрет проверяет актуальный код (round-trip через otplib)', () => {
    const secret = generateTotpSecret();
    const code = generateSync({ secret });
    expect(verifyTotpCode(code, secret)).toBe(true);
  });

  it('чужой/кривой код не проходит', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode('000000', secret) && verifyTotpCode('123456', secret)).toBe(false);
    expect(verifyTotpCode('not-a-code', secret)).toBe(false);
    expect(verifyTotpCode('', secret)).toBe(false);
  });

  it('код с пробелами нормализуется («123 456»)', () => {
    const secret = generateTotpSecret();
    const code = generateSync({ secret });
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotpCode(spaced, secret)).toBe(true);
  });

  it('otpauth-URI содержит issuer и логин', () => {
    const uri = totpKeyUri('valstan', 'JBSWY3DPEHPK3PXP');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('KARMAN');
    expect(uri).toContain('valstan');
  });

  it('AAD секрета привязан к пользователю', () => {
    expect(totpAad(17)).not.toBe(totpAad(18));
  });
});

describe('recovery-коды', () => {
  it('10 уникальных кодов формата xxxxx-xxxxx', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  });

  it('хэш стабилен к регистру/дефисам/пробелам', () => {
    expect(hashRecoveryCode('ab2cd-ef3gh')).toBe(hashRecoveryCode(' AB2CD EF3GH '));
    expect(normalizeRecoveryCode('AB2CD-EF3GH')).toBe('ab2cdef3gh');
  });

  it('отличает recovery-код от 6-значного TOTP', () => {
    expect(looksLikeRecoveryCode('ab2cd-ef3gh')).toBe(true);
    expect(looksLikeRecoveryCode('123456')).toBe(false);
  });
});
