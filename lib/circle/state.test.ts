import { describe, expect, it } from 'vitest';
import { canRejoinBySelf, memberIsActive, memberState } from './state';

const T = '2026-09-04T00:00:00Z';
const NONE = { consentedAt: null, declinedAt: null, leftAt: null, removedAt: null };

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
    // Выход не стирает consented_at. Проверь согласие первым — и человек,
    // вышедший из круга, навсегда останется «участвует», то есть его данные
    // будут видны после того, как он их закрыл.
    expect(memberState({ ...NONE, consentedAt: T, leftAt: T })).toBe('left');
    expect(memberIsActive({ ...NONE, consentedAt: T, leftAt: T })).toBe(false);
  });

  it('ИСКЛЮЧЁННЫЙ важнее всех прочих меток', () => {
    // Главный случай (утечка, найденная 2026-09-04): пока исключение писалось
    // той же меткой, что и выход, интерфейс предлагал исключённому кнопку
    // «Вернуться», и она работала.
    expect(memberState({ consentedAt: T, declinedAt: T, leftAt: T, removedAt: T })).toBe('removed');
    expect(memberState({ ...NONE, consentedAt: T, removedAt: T })).toBe('removed');
    expect(memberIsActive({ ...NONE, consentedAt: T, removedAt: T })).toBe(false);
  });

  it('передумавший после отказа считается участником', () => {
    // Отказ остаётся в истории, но согласие свежее — иначе вернуться в круг
    // было бы невозможно, не заводя вторую строку участия.
    expect(memberState({ ...NONE, consentedAt: T, declinedAt: T })).toBe('consented');
    expect(memberIsActive({ ...NONE, consentedAt: T, declinedAt: T })).toBe(true);
  });

  it('активен ТОЛЬКО согласившийся', () => {
    expect(memberIsActive(NONE)).toBe(false);
    expect(memberIsActive({ ...NONE, declinedAt: T })).toBe(false);
    expect(memberIsActive({ ...NONE, consentedAt: T })).toBe(true);
  });
});

describe('canRejoinBySelf', () => {
  it('приглашённый, отказавшийся и ушедший сам — могут войти сами', () => {
    expect(canRejoinBySelf(NONE)).toBe(true);
    expect(canRejoinBySelf({ ...NONE, declinedAt: T })).toBe(true);
    expect(canRejoinBySelf({ ...NONE, consentedAt: T, leftAt: T })).toBe(true);
  });

  it('ИСКЛЮЧЁННЫЙ сам вернуться не может — только по новому приглашению', () => {
    expect(canRejoinBySelf({ ...NONE, removedAt: T })).toBe(false);
    expect(canRejoinBySelf({ consentedAt: T, declinedAt: T, leftAt: T, removedAt: T })).toBe(false);
  });

  it('действующий участник «возвращаться» не может — он уже внутри', () => {
    expect(canRejoinBySelf({ ...NONE, consentedAt: T })).toBe(false);
  });
});
