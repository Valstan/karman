import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime } from './format';

describe('formatDate — только колонки типа date', () => {
  it('YYYY-MM-DD → DD.MM.YYYY', () => {
    expect(formatDate('2026-09-03')).toBe('03.09.2026');
  });

  it('пусто → прочерк', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
  });

  it('не-дата возвращается как есть, а не ломается', () => {
    expect(formatDate('скоро')).toBe('скоро');
  });
});

describe('formatDateTime — метки времени', () => {
  // Регрессия: раздел секретов форматировал timestamptz датным форматтером, и
  // `split('-')` отдавал день вместе с хвостом — на экране стояло
  // «03 05:44:50.191091+00.09.2026». Тест держит границу между двумя форматтерами.
  it('форма Postgres (пробел вместо T, смещение +00) разбирается', () => {
    const out = formatDateTime('2026-09-03 05:44:50.191091+00');
    expect(out).toMatch(/^\d{2}\.\d{2}\.2026 \d{2}:\d{2}$/);
    expect(out).not.toContain('+00');
    expect(out).not.toContain(':50');
  });

  it('ISO с T разбирается так же', () => {
    const pg = formatDateTime('2026-09-03 05:44:50+00');
    const iso = formatDateTime('2026-09-03T05:44:50Z');
    expect(iso).toBe(pg);
  });

  it('время сохраняется, а не обрезается до даты', () => {
    const morning = formatDateTime('2026-09-03T05:00:00Z');
    const evening = formatDateTime('2026-09-03T19:30:00Z');
    expect(morning).not.toBe(evening);
  });

  it('пусто → прочерк', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('')).toBe('—');
  });

  it('мусор возвращается как есть, а не Invalid Date', () => {
    expect(formatDateTime('никогда')).toBe('никогда');
  });
});
