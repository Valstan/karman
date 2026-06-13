import { describe, it, expect } from 'vitest';
import { addHoursIso, moscowLocalToUtcIso, moscowNextDayAtIso, utcToMoscowLocal } from './time';

describe('moscowLocalToUtcIso', () => {
  it('сдвигает московский момент на -3 часа в UTC', () => {
    expect(moscowLocalToUtcIso('2026-06-20T09:00')).toBe('2026-06-20T06:00:00.000Z');
  });

  it('корректно переходит через полночь назад', () => {
    expect(moscowLocalToUtcIso('2026-06-20T02:00')).toBe('2026-06-19T23:00:00.000Z');
  });

  it('бросает на некорректном формате', () => {
    expect(() => moscowLocalToUtcIso('2026-06-20 09:00')).toThrow();
  });
});

describe('utcToMoscowLocal', () => {
  it('обратная конверсия UTC → московский wall-clock', () => {
    expect(utcToMoscowLocal('2026-06-20T06:00:00.000Z')).toBe('2026-06-20T09:00');
  });

  it('round-trip сохраняет момент', () => {
    const local = '2026-12-31T23:30';
    expect(utcToMoscowLocal(moscowLocalToUtcIso(local))).toBe(local);
  });
});

describe('addHoursIso', () => {
  it('прибавляет часы', () => {
    expect(addHoursIso('2026-06-20T06:00:00.000Z', 1)).toBe('2026-06-20T07:00:00.000Z');
  });
});

describe('moscowNextDayAtIso', () => {
  it('завтра 09:00 МСК как UTC-инстант', () => {
    // 2026-06-20T05:00Z = 08:00 МСК того же дня → завтра 21-е, 09:00 МСК = 06:00Z.
    expect(moscowNextDayAtIso('2026-06-20T05:00:00.000Z', '09:00')).toBe('2026-06-21T06:00:00.000Z');
  });

  it('переносит конец месяца', () => {
    // 2026-06-30T20:00Z = 23:00 МСК 30 июня → завтра 1 июля 09:00 МСК = 06:00Z.
    expect(moscowNextDayAtIso('2026-06-30T20:00:00.000Z', '09:00')).toBe('2026-07-01T06:00:00.000Z');
  });
});
