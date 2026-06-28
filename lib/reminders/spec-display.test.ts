import { describe, it, expect } from 'vitest';
import {
  formValuesToSpec,
  formatMoscowInstant,
  specToFormValues,
  describeSpec,
  type ReminderFormValues,
} from './spec-display';
import type { ScheduleSpec } from './types';

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
  dates: [],
  datesTime: '09:00',
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

describe('formValuesToSpec — режим dates', () => {
  it('repeat=dates → kind:dates, даты сортируются, единое время', () => {
    expect(
      formValuesToSpec({ ...base, repeat: 'dates', dates: ['2026-07-10', '2026-06-30'], datesTime: '18:00' }),
    ).toEqual({ kind: 'dates', dates: ['2026-06-30', '2026-07-10'], times: ['18:00'] });
  });

  it('пустое время → дефолт 09:00', () => {
    expect(formValuesToSpec({ ...base, repeat: 'dates', dates: ['2026-07-10'], datesTime: '' })).toEqual({
      kind: 'dates',
      dates: ['2026-07-10'],
      times: ['09:00'],
    });
  });
});

describe('round-trip dates: spec → форма → spec', () => {
  it('specToFormValues ∘ formValuesToSpec — тождество для dates', () => {
    const spec: ScheduleSpec = { kind: 'dates', dates: ['2026-06-30', '2026-07-10'], times: ['18:00'] };
    const merged = { ...base, ...specToFormValues(spec) } as ReminderFormValues;
    expect(formValuesToSpec(merged)).toEqual(spec);
  });
});

describe('describeSpec — dates', () => {
  it('описывает количество дат и время', () => {
    expect(describeSpec({ kind: 'dates', dates: ['2026-06-30', '2026-07-10'], times: ['18:00'] })).toBe(
      'По датам: 2 дат в 18:00',
    );
    expect(describeSpec({ kind: 'dates', dates: ['2026-06-30'], times: ['09:00'] })).toBe(
      'По датам: 1 дата в 09:00',
    );
  });
});

describe('formatMoscowInstant', () => {
  it('UTC ISO → ДД.ММ.ГГГГ ЧЧ:ММ по Москве (UTC+3)', () => {
    expect(formatMoscowInstant('2026-06-20T06:00:00.000Z')).toBe('20.06.2026 09:00');
    expect(formatMoscowInstant('2026-12-31T21:00:00.000Z')).toBe('01.01.2027 00:00');
  });
});
