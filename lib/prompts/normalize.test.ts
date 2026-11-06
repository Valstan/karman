import { describe, expect, it } from 'vitest';
import {
  derivePromptTitle,
  normalizePromptText,
  MAX_PROMPT_TITLE_LENGTH,
} from '@/lib/prompts/normalize';

/**
 * Нормализация промта: детерминированная часть причёмы надиктованного.
 *
 * Смысл проверяем здесь один: правится ТОЛЬКО форма. Ни одного символа
 * словаря промта нормализация не меняет — этим занимается Мозг, и его правки
 * должны быть видны в тексте как есть.
 */
describe('normalizePromptText', () => {
  it('переводит CRLF в LF и убирает BOM', () => {
    expect(normalizePromptText('\uFEFFПервая\r\nВторая')).toBe('Первая\nВторая');
  });

  it('срезает висячие пробелы в конце строк', () => {
    expect(normalizePromptText('Первая   \nВторая\t')).toBe('Первая\nВторая');
  });

  it('оставляет не больше одной пустой строки подряд', () => {
    expect(normalizePromptText('Одна\n\n\n\nДве')).toBe('Одна\n\nДве');
  });

  it('срезает пустые строки по краям', () => {
    expect(normalizePromptText('\n\n  Текст  \n\n')).toBe('Текст');
  });

  it('не трогает слова и пунктуацию', () => {
    const raw = 'Сделай, пожалуйста, ТЗ — и пришли его мне.';
    expect(normalizePromptText(raw)).toBe(raw);
  });

  it('пустая строка остаётся пустой', () => {
    expect(normalizePromptText('   \n  ')).toBe('');
  });
});

describe('derivePromptTitle', () => {
  it('берёт первую непустую строку', () => {
    expect(derivePromptTitle('\n\nЗаголовок промта\nтело')).toBe('Заголовок промта');
  });

  it('обрезает слишком длинную первую строку', () => {
    const title = derivePromptTitle('я'.repeat(300));
    expect(title).toHaveLength(MAX_PROMPT_TITLE_LENGTH);
    expect(title.endsWith('…')).toBe(true);
  });

  it('пустому промту — пустой заголовок', () => {
    expect(derivePromptTitle('')).toBe('');
  });
});
