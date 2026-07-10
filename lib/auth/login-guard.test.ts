import { describe, it, expect } from 'vitest';
import { loginGuardKey, loginAllowed, registerFailure, registerSuccess } from './login-guard';

const MIN = 60_000;

describe('login-guard', () => {
  it('ключ нормализует логин, различает IP', () => {
    expect(loginGuardKey(' Admin ', '1.2.3.4')).toBe('admin|1.2.3.4');
    expect(loginGuardKey('admin', null)).toBe('admin|-');
    expect(loginGuardKey('admin', '1.2.3.4')).not.toBe(loginGuardKey('admin', '5.6.7.8'));
  });

  it('10 неудач в окне → lockout; до этого вход разрешён', () => {
    const key = 'u1|ip';
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i++) {
      expect(registerFailure(key, t0 + i * 1000)).toBe(false);
      expect(loginAllowed(key, t0 + i * 1000)).toBe(true);
    }
    expect(registerFailure(key, t0 + 9000)).toBe(true); // 10-я — блокирует
    expect(loginAllowed(key, t0 + 10_000)).toBe(false);
  });

  it('lockout истекает через 15 минут', () => {
    const key = 'u2|ip';
    const t0 = 2_000_000;
    for (let i = 0; i < 10; i++) registerFailure(key, t0);
    expect(loginAllowed(key, t0 + 14 * MIN)).toBe(false);
    expect(loginAllowed(key, t0 + 15 * MIN)).toBe(true);
  });

  it('неудачи вне 15-минутного окна не копятся', () => {
    const key = 'u3|ip';
    const t0 = 3_000_000;
    for (let i = 0; i < 9; i++) registerFailure(key, t0);
    // Окно истекло — счётчик начинается заново, блокировки нет.
    expect(registerFailure(key, t0 + 16 * MIN)).toBe(false);
    expect(loginAllowed(key, t0 + 16 * MIN)).toBe(true);
  });

  it('успех сбрасывает счётчик', () => {
    const key = 'u4|ip';
    const t0 = 4_000_000;
    for (let i = 0; i < 9; i++) registerFailure(key, t0);
    registerSuccess(key);
    expect(registerFailure(key, t0 + 1000)).toBe(false);
    expect(loginAllowed(key, t0 + 1000)).toBe(true);
  });
});
