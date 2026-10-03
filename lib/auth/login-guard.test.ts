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
      expect(registerFailure(key, 'u1', t0 + i * 1000)).toBe(false);
      expect(loginAllowed(key, 'u1', t0 + i * 1000)).toBe(true);
    }
    expect(registerFailure(key, 'u1', t0 + 9000)).toBe(true); // 10-я — блокирует
    expect(loginAllowed(key, 'u1', t0 + 10_000)).toBe(false);
  });

  it('lockout истекает через 15 минут', () => {
    const key = 'u2|ip';
    const t0 = 2_000_000;
    for (let i = 0; i < 10; i++) registerFailure(key, 'u2', t0);
    expect(loginAllowed(key, 'u2', t0 + 14 * MIN)).toBe(false);
    expect(loginAllowed(key, 'u2', t0 + 15 * MIN)).toBe(true);
  });

  it('неудачи вне 15-минутного окна не копятся', () => {
    const key = 'u3|ip';
    const t0 = 3_000_000;
    for (let i = 0; i < 9; i++) registerFailure(key, 'u3', t0);
    // Окно истекло — счётчик начинается заново, блокировки нет.
    expect(registerFailure(key, 'u3', t0 + 16 * MIN)).toBe(false);
    expect(loginAllowed(key, 'u3', t0 + 16 * MIN)).toBe(true);
  });

  it('успех сбрасывает счётчик', () => {
    const key = 'u4|ip';
    const t0 = 4_000_000;
    for (let i = 0; i < 9; i++) registerFailure(key, 'u4', t0);
    registerSuccess(key, 'u4');
    expect(registerFailure(key, 'u4', t0 + 1000)).toBe(false);
    expect(loginAllowed(key, 'u4', t0 + 1000)).toBe(true);
  });

  /**
   * Контроль к находке R1 аудита #057: ротация адреса не должна обнулять счётчик.
   *
   * Пока ключ жил только на паре `логин|IP`, а IP брался из подделываемого
   * `X-Forwarded-For`, блокировка не срабатывала никогда. Теперь у логина есть
   * собственный предел, независимый от адреса.
   */
  it('ротация IP не обходит блокировку логина', () => {
    const t0 = 5_000_000;
    const account = 'rotator';
    // Каждая попытка — с нового адреса, то есть каждая пара логин+адрес получает
    // ровно одну неудачу и никогда не доходит до своего предела в 10.
    for (let i = 0; i < 9; i++) {
      expect(registerFailure(`rotator|10.0.0.${i}`, account, t0)).toBe(false);
    }
    expect(loginAllowed('rotator|10.9.9.9', account, t0)).toBe(true);

    // Предел по логину копится независимо от адресов и срабатывает.
    for (let i = 9; i < 49; i++) {
      registerFailure(`rotator|10.0.0.${i}`, account, t0);
    }
    expect(registerFailure('rotator|10.9.9.9', account, t0)).toBe(true);
    // Ни один адрес больше не помогает, пока окно не истекло.
    expect(loginAllowed('rotator|10.8.8.8', account, t0)).toBe(false);
    expect(loginAllowed('rotator|10.0.0.1', account, t0 + 15 * MIN)).toBe(true);
  });

  it('предел по логину выше, чем по паре логин+адрес', () => {
    // 10 попыток с одного адреса блокируют пару; следующий адрес ещё пробует.
    const t0 = 6_000_000;
    const account = 'user1';
    for (let i = 0; i < 10; i++) registerFailure(`user1|10.0.0.1`, account, t0);
    expect(loginAllowed('user1|10.0.0.1', account, t0)).toBe(false);
    expect(loginAllowed('user1|10.0.0.2', account, t0)).toBe(true);
  });

  it('чужие логины не мешают друг другу', () => {
    const t0 = 7_000_000;
    for (let i = 0; i < 10; i++) registerFailure('a|10.0.0.1', 'a', t0);
    expect(loginAllowed('b|10.0.0.1', 'b', t0)).toBe(true);
  });
});