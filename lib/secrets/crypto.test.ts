import { describe, it, expect, beforeAll } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  secretAad,
  cardTitleAad,
  cardFieldAad,
  secretsConfigured,
} from './crypto';

beforeAll(() => {
  process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
});

describe('crypto', () => {
  it('round-trip encrypt→decrypt', () => {
    const aad = secretAad(1, 'DATABASE_URL');
    const enc = encryptSecret('postgres://secret', aad);
    expect(decryptSecret(enc, aad)).toBe('postgres://secret');
  });

  it('каждый вызов — новый IV (рандомизированное шифрование)', () => {
    const aad = secretAad(1, 'K');
    const a = encryptSecret('v', aad);
    const b = encryptSecret('v', aad);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('несовпадение AAD → ошибка (нельзя переставить шифротекст между строками)', () => {
    const enc = encryptSecret('v', secretAad(1, 'A'));
    expect(() => decryptSecret(enc, secretAad(1, 'B'))).toThrow();
    expect(() => decryptSecret(enc, secretAad(2, 'A'))).toThrow();
  });

  it('повреждённый шифротекст → ошибка (GCM auth fail)', () => {
    const aad = secretAad(1, 'A');
    const enc = encryptSecret('v', aad);
    const tampered = { ...enc, ciphertext: Buffer.from('tampered').toString('base64') };
    expect(() => decryptSecret(tampered, aad)).toThrow();
  });

  it('карточные AAD: round-trip + нельзя переставить между карточками/полями', () => {
    const title = encryptSecret('Ключ ВК', cardTitleAad(10));
    expect(decryptSecret(title, cardTitleAad(10))).toBe('Ключ ВК');
    expect(() => decryptSecret(title, cardTitleAad(11))).toThrow();

    const field = encryptSecret('vk1.a.xxx', cardFieldAad(10, 'Значение'));
    expect(decryptSecret(field, cardFieldAad(10, 'Значение'))).toBe('vk1.a.xxx');
    expect(() => decryptSecret(field, cardFieldAad(10, 'Логин'))).toThrow();
    expect(() => decryptSecret(field, cardFieldAad(11, 'Значение'))).toThrow();
    // Поле не спутать с env-секретом и наоборот (разные namespace AAD).
    expect(() => decryptSecret(field, secretAad(10, 'Значение'))).toThrow();
  });

  it('длинное значение (256 КБ) шифруется и возвращается целиком', () => {
    const long = 'x'.repeat(262144);
    const aad = cardFieldAad(1, 'Сертификат');
    expect(decryptSecret(encryptSecret(long, aad), aad)).toBe(long);
  });

  it('secretsConfigured отражает наличие ключа', () => {
    expect(secretsConfigured()).toBe(true);
    const saved = process.env.SECRETS_MASTER_KEY;
    delete process.env.SECRETS_MASTER_KEY;
    expect(secretsConfigured()).toBe(false);
    process.env.SECRETS_MASTER_KEY = saved;
  });
});
