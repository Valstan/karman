import { describe, it, expect } from 'vitest';
import { moscowLocalToUtcIso, utcToMoscowLocal } from './time';

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
