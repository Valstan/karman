import { describe, it, expect } from 'vitest';
import { formValuesToSpec, formatMoscowInstant, type ReminderFormValues } from './spec-display';

const base: ReminderFormValues = {
  title: 'T',
  body: '',
  at: '2026-06-20T09:00',
  priority: 'normal',
  silent: false,
  repeat: 'none',
  interval: 1,
  weekdays: [],
  monthday: '',
  endType: 'never',
  endN: '',
  endUntil: '',
  businessDaysOnly: false,
  quietEnabled: false,
  quietFrom: '',
  quietTo: '',
  quietDefer: '',
};

describe('formValuesToSpec', () => {
  it('repeat=none → oneoff', () => {
    expect(formValuesToSpec(base)).toEqual({ kind: 'oneoff', at: '2026-06-20T09:00' });
  });

  it('daily → recurring со startDate/time из at', () => {
    expect(formValuesToSpec({ ...base, repeat: 'daily', interval: 2 })).toEqual({
      kind: 'recurring',
      freq: 'daily',
      interval: 2,
      startDate: '2026-06-20',
      time: '09:00',
    });
  });

  it('weekly включает weekdays только если выбраны', () => {
    expect(formValuesToSpec({ ...base, repeat: 'weekly', weekdays: [1, 3] })).toMatchObject({
      kind: 'recurring',
      freq: 'weekly',
      weekdays: [1, 3],
    });
    expect(formValuesToSpec({ ...base, repeat: 'weekly', weekdays: [] })).not.toHaveProperty('weekdays');
  });

  it('monthly включает monthday только если задан', () => {
    expect(formValuesToSpec({ ...base, repeat: 'monthly', monthday: 15 })).toMatchObject({
      freq: 'monthly',
      monthday: 15,
    });
    expect(formValuesToSpec({ ...base, repeat: 'monthly', monthday: '' })).not.toHaveProperty('monthday');
  });

  it('окончания: afterN и until', () => {
    expect(formValuesToSpec({ ...base, endType: 'afterN', endN: 5 }).end).toEqual({ type: 'afterN', n: 5 });
    expect(formValuesToSpec({ ...base, endType: 'until', endUntil: '2026-12-31' }).end).toEqual({
      type: 'until',
      until: '2026-12-31',
    });
    expect(formValuesToSpec(base).end).toBeUndefined();
  });

  it('тихие часы и будни — только при полном наборе/флаге', () => {
    const spec = formValuesToSpec({
      ...base,
      repeat: 'daily',
      businessDaysOnly: true,
      quietEnabled: true,
      quietFrom: '22:00',
      quietTo: '08:00',
      quietDefer: '08:00',
    });
    expect(spec).toMatchObject({
      businessDaysOnly: true,
      quietHours: { from: '22:00', to: '08:00', deferTo: '08:00' },
    });
    // неполный набор тихих часов → не добавляем
    expect(
      formValuesToSpec({ ...base, repeat: 'daily', quietEnabled: true, quietFrom: '22:00' }),
    ).not.toHaveProperty('quietHours');
  });
});

describe('formatMoscowInstant', () => {
  it('UTC ISO → ДД.ММ.ГГГГ ЧЧ:ММ по Москве (UTC+3)', () => {
    expect(formatMoscowInstant('2026-06-20T06:00:00.000Z')).toBe('20.06.2026 09:00');
    expect(formatMoscowInstant('2026-12-31T21:00:00.000Z')).toBe('01.01.2027 00:00');
  });
});
