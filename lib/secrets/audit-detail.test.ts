import { describe, expect, it } from 'vitest';
import { projectDeletedDetail } from './audit-detail';

describe('projectDeletedDetail — строка аудита, переживающая каскад удаления комнаты', () => {
  it('slug и счётчики в формате k=v, порядок фиксирован', () => {
    expect(projectDeletedDetail('trener', { audit: 786, tokens: 1, items: 12 })).toBe(
      'slug=trener audit=786 tokens=1 items=12',
    );
  });

  it('пустая комната — нули, а не пропуски: «0» отличим от «не посчитали»', () => {
    expect(projectDeletedDetail('empty', { audit: 0, tokens: 0, items: 0 })).toBe(
      'slug=empty audit=0 tokens=0 items=0',
    );
  });
});
