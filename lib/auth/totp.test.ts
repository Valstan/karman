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
  newRecoverySalt,
  RECOVERY_CODE_LENGTH,
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
  it('10 уникальных кодов формата xxxxx-xxxxx-xxxxx-xxxxx (100 бит)', () => {
    // Аудит #057 S2: прежний формат давал ~49,5 бита (31 символ × 10 байт), и офлайн-перебор
    // дампа находил один из десяти кодов за десятки минут на GPU. Теперь 20 символов из
    // алфавита в 32 символа.
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/);
    for (const c of codes) expect(normalizeRecoveryCode(c)).toHaveLength(RECOVERY_CODE_LENGTH);
  });

  it('алфавит без неоднозначных символов — код читается вслух и вводится с телефона', () => {
    expect(generateRecoveryCodes(40).join('')).not.toMatch(/[ilo01]/);
  });

  it('хэш стабилен к регистру/дефисам/пробелам', () => {
    expect(hashRecoveryCode('ab2cd-ef3gh-ij2km-qr2st', 'salt-1')).toBe(
      hashRecoveryCode(' AB2CD EF3GH IJ2KM QR2ST ', 'salt-1'),
    );
    expect(normalizeRecoveryCode('AB2CD-EF3GH')).toBe('ab2cdef3gh');
  });

  /**
   * KDF с солью (аудит #057 S2). Проверяются ОБЕ ветки: новая (pbkdf2 с солью) и легаси
   * (несолёный SHA-256), потому что старые строки в бою лежат без соли и обязаны работать,
   * пока владелец не перевыдаст коды.
   */
  it('новая ветка: соль меняет хэш, код проверяется только своей солью', () => {
    const code = generateRecoveryCodes(1)[0] ?? '';
    const a = hashRecoveryCode(code, 'salt-a');
    const b = hashRecoveryCode(code, 'salt-b');
    expect(a).not.toBe(b);
    expect(hashRecoveryCode(code, 'salt-a')).toBe(a);
    expect(hashRecoveryCode(code, 'other')).not.toBe(a);
  });

  it('легаси-ветка: без соли остаётся SHA-256 и не зависит от KDF', () => {
    const code = 'ab2cd-ef3gh';
    const legacy = hashRecoveryCode(code);
    expect(legacy).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(code, null)).toBe(legacy);
    expect(hashRecoveryCode(code, undefined)).toBe(legacy);
    // Разница с новой веткой обязательна, иначе миграция была бы косметической.
    expect(hashRecoveryCode(code, 'salt-a')).not.toBe(legacy);
  });

  it('соль новая на каждый код — иначе одинаковые коды дали бы одинаковые хэши', () => {
    const salts = new Set(Array.from({ length: 20 }, () => newRecoverySalt()));
    expect(salts.size).toBe(20);
    const values = [...salts];
    expect(values.every((s) => /^[0-9a-f]{32}$/.test(s))).toBe(true);
  });

  it('выборка символа без смещения: длина фиксирована, распределение ровное', () => {
    // Регрессия на две ошибки подряд: `b % 31` выдавал первые буквы заметно чаще (256 % 31 не
    // ноль), а `b & 31` при алфавите в 31 символ иногда давал индекс 31, то есть код выходил
    // на символ короче. Ловятся обе ловушки: длиной и распределением.
    const codes = generateRecoveryCodes(200);
    for (const c of codes) expect(normalizeRecoveryCode(c)).toHaveLength(RECOVERY_CODE_LENGTH);

    const counts = new Map<string, number>();
    for (const c of codes) {
      for (const ch of normalizeRecoveryCode(c)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    // Все 31 символ алфавита должны встретиться: при смещении часть выпадала бы заметно реже.
    for (const ch of 'abcdefghjkmnpqrstuvwxyz23456789') {
      expect(counts.get(ch) ?? 0).toBeGreaterThan(0);
    }
    const values = [...counts.values()];
    const max = Math.max(...values);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(max * 0.5);
  });

  it('отличает recovery-код от 6-значного TOTP и принимает оба формата', () => {
    expect(looksLikeRecoveryCode('ab2cd-ef3gh-ij2km-qr2st')).toBe(true);
    // Старый формат тоже распознаётся: переезд на новый не должен ломать невыданные коды.
    expect(looksLikeRecoveryCode('ab2cd-ef3gh')).toBe(true);
    expect(looksLikeRecoveryCode('123456')).toBe(false);
    expect(looksLikeRecoveryCode('ab2cd-ef3gh-ij2km-qr2st-x')).toBe(false);
  });
});
