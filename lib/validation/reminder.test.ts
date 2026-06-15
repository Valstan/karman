import { describe, it, expect } from 'vitest';
import { reminderCreateSchema } from './reminder';

const base = {
  title: 'Тест',
  at: '2026-06-26T23:30',
  repeat: 'daily' as const,
};

describe('reminderCreateSchema', () => {
  it('парсит повтор без endUntil при endType=never (регрессия Zod v4: union-с-undefined ≠ optional)', () => {
    // Форма опускает ключ endUntil, когда endType≠until. До фикса absent-ключ
    // давал "expected nonoptional" и весь create-путь повторов падал.
    const r = reminderCreateSchema.safeParse({ ...base, endType: 'never' });
    expect(r.success).toBe(true);
  });

  it('пропускает тихие часы и рабочие дни без срезания', () => {
    const r = reminderCreateSchema.safeParse({
      ...base,
      businessDaysOnly: true,
      quietEnabled: true,
      quietFrom: '22:00',
      quietTo: '08:00',
      quietDefer: '08:00',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.businessDaysOnly).toBe(true);
      expect(r.data.quietFrom).toBe('22:00');
      expect(r.data.quietTo).toBe('08:00');
      expect(r.data.quietDefer).toBe('08:00');
    }
  });

  it('отвергает время тихих часов в неверном формате', () => {
    const r = reminderCreateSchema.safeParse({ ...base, quietFrom: '9am' });
    expect(r.success).toBe(false);
  });

  it('разовое напоминание (repeat=none) без полей расписания валидно', () => {
    const r = reminderCreateSchema.safeParse({ title: 'Раз', at: '2026-07-01T09:00' });
    expect(r.success).toBe(true);
  });
});
