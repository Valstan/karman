import { describe, expect, it } from 'vitest';
import { memberIsActive, memberState } from './state';

const T = '2026-09-04T00:00:00Z';
const NONE = { consentedAt: null, declinedAt: null, leftAt: null };

/**
 * От этой функции зависит, увидит ли один человек паспортные данные другого,
 * поэтому проверяются не «нормальные» случаи, а сочетания меток: в жизни строка
 * участия накапливает историю, и одновременно непустых меток бывает несколько.
 */
describe('memberState', () => {
  it('приглашён и не ответил', () => {
    expect(memberState(NONE)).toBe('invited');
  });

  it('согласился', () => {
    expect(memberState({ ...NONE, consentedAt: T })).toBe('consented');
  });

  it('отказался', () => {
    expect(memberState({ ...NONE, declinedAt: T })).toBe('declined');
  });

  it('ВЫШЕДШИЙ не считается участником, хотя согласие в истории осталось', () => {
    // Главный случай: выход не стирает consented_at. Проверь согласие первым —
    // и человек, вышедший из круга, навсегда останется «участвует», то есть
    // его данные будут видны после того, как он их закрыл.
    expect(memberState({ consentedAt: T, declinedAt: null, leftAt: T })).toBe('left');
    expect(memberIsActive({ consentedAt: T, declinedAt: null, leftAt: T })).toBe(false);
  });

  it('передумавший после отказа считается участником', () => {
    // Отказ остаётся в истории, но согласие свежее — иначе вернуться в круг
    // было бы невозможно, не заводя вторую строку участия.
    expect(memberState({ consentedAt: T, declinedAt: T, leftAt: null })).toBe('consented');
    expect(memberIsActive({ consentedAt: T, declinedAt: T, leftAt: null })).toBe(true);
  });

  it('вышедший после отказа и согласия всё равно вышедший', () => {
    expect(memberState({ consentedAt: T, declinedAt: T, leftAt: T })).toBe('left');
  });

  it('активен ТОЛЬКО согласившийся', () => {
    expect(memberIsActive(NONE)).toBe(false);
    expect(memberIsActive({ ...NONE, declinedAt: T })).toBe(false);
    expect(memberIsActive({ ...NONE, consentedAt: T })).toBe(true);
  });
});
