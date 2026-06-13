import { describe, it, expect } from 'vitest';
import { substitute } from './template';

describe('substitute', () => {
  it('подставляет Unicode-ключи', () => {
    expect(substitute('Внести {сумма} до {дата}', { сумма: '42 300 ₽', дата: '16.06.2026' })).toBe(
      'Внести 42 300 ₽ до 16.06.2026',
    );
  });

  it('оставляет неизвестные плейсхолдеры как есть', () => {
    expect(substitute('{есть} и {нет}', { есть: 'X' })).toBe('X и {нет}');
  });

  it('без плейсхолдеров возвращает как есть', () => {
    expect(substitute('просто текст', {})).toBe('просто текст');
  });
});
