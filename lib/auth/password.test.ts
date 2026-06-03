import { describe, it, expect } from 'vitest';
import { verifyDjangoPassword, hashDjangoPassword } from './password';

// Тот же хеш, что в scripts/bootstrap.sql (admin / admin123).
const ADMIN_HASH = 'pbkdf2_sha256$260000$devsalt12345678$+STEz7mNAe0s1dphwRqFsJQf0f65Du5cTtlcjk0Yj+I=';

describe('verifyDjangoPassword', () => {
  it('принимает верный пароль', () => {
    expect(verifyDjangoPassword('admin123', ADMIN_HASH)).toBe(true);
  });

  it('отклоняет неверный пароль', () => {
    expect(verifyDjangoPassword('wrong', ADMIN_HASH)).toBe(false);
  });

  it('отклоняет «непригодные» хеши (префикс !)', () => {
    expect(verifyDjangoPassword('x', '!unusable')).toBe(false);
  });

  it('отклоняет пустой/битый хеш', () => {
    expect(verifyDjangoPassword('x', '')).toBe(false);
    expect(verifyDjangoPassword('x', 'garbage')).toBe(false);
  });
});

describe('hashDjangoPassword + verify (round-trip)', () => {
  it('сгенерированный хеш проходит проверку', () => {
    const hash = hashDjangoPassword('s3cret', 50000);
    expect(hash.startsWith('pbkdf2_sha256$50000$')).toBe(true);
    expect(verifyDjangoPassword('s3cret', hash)).toBe(true);
    expect(verifyDjangoPassword('nope', hash)).toBe(false);
  });
});
