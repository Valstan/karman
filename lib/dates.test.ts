import { describe, it, expect } from 'vitest';
import { addMonths, daysBetween, daysUntil } from './dates';
import { documentExpiryBadge } from './constants';

describe('dates', () => {
  it('addMonths переносит через границу года и зажимает день месяца', () => {
    expect(addMonths('2026-01-15', 1)).toBe('2026-02-15');
    expect(addMonths('2026-11-30', 2)).toBe('2027-01-30');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28'); // нет 31-го февраля
    expect(addMonths('2026-03-15', -1)).toBe('2026-02-15');
  });

  it('daysBetween считает целые дни без таймзонных сдвигов', () => {
    expect(daysBetween('2026-06-01', '2026-06-01')).toBe(0);
    expect(daysBetween('2026-06-01', '2026-06-10')).toBe(9);
    expect(daysBetween('2026-06-10', '2026-06-01')).toBe(-9);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1); // 2026 не високосный
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('daysUntil отсчитывает от переданного «сегодня»', () => {
    expect(daysUntil('2026-06-10', '2026-06-04')).toBe(6);
    expect(daysUntil('2026-06-04', '2026-06-04')).toBe(0);
    expect(daysUntil('2026-06-01', '2026-06-04')).toBe(-3);
  });
});

describe('documentExpiryBadge', () => {
  const today = '2026-06-04';

  it('нет бейджа без даты или когда срок далеко', () => {
    expect(documentExpiryBadge(null, today)).toBeNull();
    expect(documentExpiryBadge('', today)).toBeNull();
    expect(documentExpiryBadge('2026-12-31', today)).toBeNull(); // > 30 дней
  });

  it('просроченные и истекающие сегодня — destructive', () => {
    expect(documentExpiryBadge('2026-06-01', today)).toEqual({
      label: 'Просрочен',
      variant: 'destructive',
    });
    expect(documentExpiryBadge('2026-06-04', today)).toEqual({
      label: 'Истекает сегодня',
      variant: 'destructive',
    });
  });

  it('истекающие в пределах 30 дней — outline с числом дней', () => {
    expect(documentExpiryBadge('2026-06-10', today)).toEqual({
      label: 'Истекает через 6 дн.',
      variant: 'outline',
    });
    expect(documentExpiryBadge('2026-07-04', today)).toEqual({
      label: 'Истекает через 30 дн.',
      variant: 'outline',
    });
  });
});
