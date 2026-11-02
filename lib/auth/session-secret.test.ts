import { describe, expect, it } from 'vitest';
import {
  assertSessionSecret,
  sessionSecretProblem,
  SESSION_SECRET_MIN_LENGTH,
} from './session-secret';

/**
 * S1, аудит #057: проверялось только НАЛИЧИЕ SESSION_SECRET, а значение
 * `change-me-in-production` принималось. Прод на таком плейсхолдере тихо
 * работал — с ключом, напечатанным в README и в шаблоне юнита.
 */
describe('SESSION_SECRET: проверяется значение, а не только наличие (S1)', () => {
  it('плейсхолдеры из шаблонов не проходят', () => {
    expect(sessionSecretProblem('change-me-in-production')).not.toBeNull();
    expect(sessionSecretProblem('dev-insecure-secret-change-me')).not.toBeNull();
    // маркер ловится и ВХОЖДЕНИЕМ, а не точным равенством: шаблон меняют —
    // проверка на равенство тогда бы молча перестала ловить.
    expect(sessionSecretProblem('change-me-before-prod-2026')).not.toBeNull();
    expect(sessionSecretProblem('CHANGE-ME-in-production')).not.toBeNull();
  });

  it('короткий секрет не проходит', () => {
    expect(sessionSecretProblem('short')).not.toBeNull();
    expect(sessionSecretProblem('a'.repeat(SESSION_SECRET_MIN_LENGTH - 1))).not.toBeNull();
  });

  it('пустой секрет не проходит', () => {
    expect(sessionSecretProblem(undefined)).not.toBeNull();
    expect(sessionSecretProblem('')).not.toBeNull();
    expect(sessionSecretProblem('   ')).not.toBeNull();
  });

  it('нормальный секрет проходит', () => {
    const secret = 'k'.repeat(48);
    expect(sessionSecretProblem(secret)).toBeNull();
    expect(() => assertSessionSecret(secret)).not.toThrow();
  });

  it('CI-заглушка проходит: сборка прод-артефакта не должна ломаться', () => {
    const ciSecret = 'ci-dummy-secret-not-used-in-prod';
    expect(ciSecret.length).toBeGreaterThanOrEqual(SESSION_SECRET_MIN_LENGTH);
    expect(sessionSecretProblem(ciSecret)).toBeNull();
  });

  it('текст ошибки не содержит сам секрет', () => {
    const secret = 'change-me-in-production';
    let message = '';
    try {
      assertSessionSecret(secret);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(secret);
  });
});
