import { describe, it, expect } from 'vitest';
import { parseCallbackData } from './callback';

describe('parseCallbackData', () => {
  it('разбирает done', () => {
    expect(parseCallbackData('done:42')).toEqual({ action: 'done', deliveryId: 42, arg: undefined });
  });

  it('разбирает snooze с аргументом', () => {
    expect(parseCallbackData('snz:7:tmrw')).toEqual({ action: 'snz', deliveryId: 7, arg: 'tmrw' });
  });

  it('отвергает неизвестное действие', () => {
    expect(parseCallbackData('nuke:1')).toBeNull();
  });

  it('отвергает некорректный id', () => {
    expect(parseCallbackData('done:abc')).toBeNull();
    expect(parseCallbackData('done:0')).toBeNull();
    expect(parseCallbackData('done:-3')).toBeNull();
  });

  it('отвергает пустую строку', () => {
    expect(parseCallbackData('')).toBeNull();
  });
});
