import { describe, it, expect } from 'vitest';
import { toKopecks, fromKopecks } from './money';

describe('money', () => {
  it('toKopecks парсит строки и числа', () => {
    expect(toKopecks('123.45')).toBe(12345);
    expect(toKopecks('1000')).toBe(100000);
    expect(toKopecks('0.5')).toBe(50);
    expect(toKopecks('99,99')).toBe(9999);
    expect(toKopecks(10.99)).toBe(1099);
  });

  it('fromKopecks форматирует с двумя знаками', () => {
    expect(fromKopecks(12345)).toBe('123.45');
    expect(fromKopecks(100000)).toBe('1000.00');
    expect(fromKopecks(5)).toBe('0.05');
  });

  it('round-trip сохраняет значение', () => {
    for (const v of ['0.00', '1.01', '300000.00', '7.77']) {
      expect(fromKopecks(toKopecks(v))).toBe(v);
    }
  });
});
