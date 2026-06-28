import { utcToMoscowLocal } from './time';
import type { ScheduleEnd, ScheduleSpec } from './types';

/** Поля формы напоминания (UI). Пустые числовые — '' (не отправляются в zod). */
export type ReminderFormValues = {
  title: string;
  body: string;
  at: string; // 'YYYY-MM-DDTHH:MM' (МСК)
  priority: 'normal' | 'high';
  silent: boolean;
  repeat: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  weekdays: number[]; // 0=Вс..6=Сб
  monthday: number | '';
  endType: 'never' | 'afterN' | 'until';
  endN: number | '';
  endUntil: string; // 'YYYY-MM-DD' | ''
  businessDaysOnly: boolean;
  quietEnabled: boolean;
  quietFrom: string; // 'HH:MM' | ''
  quietTo: string; // 'HH:MM' | ''
  quietDefer: string; // 'HH:MM' | ''
};

/** Дефолт тихих часов при включении чекбокса: ночь 22:00–08:00 → перенос на 08:00. */
export const QUIET_HOURS_DEFAULT = { from: '22:00', to: '08:00', deferTo: '08:00' };

export const WEEKDAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
/** Порядок показа: Пн..Вс. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const FREQ_LABEL: Record<string, string> = {
  daily: 'Ежедневно',
  weekly: 'Еженедельно',
  monthly: 'Ежемесячно',
  yearly: 'Ежегодно',
};
const INTERVAL_UNIT: Record<string, string> = {
  daily: 'дн.',
  weekly: 'нед.',
  monthly: 'мес.',
  yearly: 'г.',
};

export function specToFormValues(spec: ScheduleSpec | null): Partial<ReminderFormValues> {
  if (!spec) {
    return { repeat: 'none', interval: 1, weekdays: [], endType: 'never' };
  }
  const end = spec.end;
  const endFields = {
    endType: end?.type === 'afterN' ? ('afterN' as const) : end?.type === 'until' ? ('until' as const) : ('never' as const),
    endN: end?.type === 'afterN' ? end.n : ('' as const),
    endUntil: end?.type === 'until' ? end.until : '',
  };

  if (spec.kind === 'oneoff') {
    return { at: spec.at, repeat: 'none', interval: 1, weekdays: [], ...endFields };
  }
  if (spec.kind === 'recurring') {
    return {
      at: `${spec.startDate}T${spec.time}`,
      repeat: spec.freq,
      interval: spec.interval,
      weekdays: spec.weekdays ?? [],
      monthday: spec.monthday ?? '',
      businessDaysOnly: spec.businessDaysOnly ?? false,
      quietEnabled: Boolean(spec.quietHours),
      quietFrom: spec.quietHours?.from ?? '',
      quietTo: spec.quietHours?.to ?? '',
      quietDefer: spec.quietHours?.deferTo ?? '',
      ...endFields,
    };
  }
  // dates / relative — форма их не редактирует (P4/позже)
  return { repeat: 'none', interval: 1, weekdays: [], ...endFields };
}

function endFromValues(v: ReminderFormValues): ScheduleEnd | undefined {
  if (v.endType === 'afterN' && v.endN !== '') return { type: 'afterN', n: Number(v.endN) };
  if (v.endType === 'until' && v.endUntil) return { type: 'until', until: v.endUntil };
  return undefined; // never
}

/**
 * Значения формы → ScheduleSpec. Зеркало серверного `buildSpec`
 * (lib/services/reminders.ts) — нужно для предпросмотра «когда сработает» прямо в
 * форме (сервер пересчитывает спеку при сохранении, он остаётся источником правды).
 * Держать в синхроне с buildSpec; обратное преобразование — specToFormValues.
 */
export function formValuesToSpec(v: ReminderFormValues): ScheduleSpec {
  const end = endFromValues(v);
  if (v.repeat === 'none') {
    return { kind: 'oneoff', at: v.at, ...(end ? { end } : {}) };
  }
  const quietHours =
    v.quietEnabled && v.quietFrom && v.quietTo && v.quietDefer
      ? { from: v.quietFrom, to: v.quietTo, deferTo: v.quietDefer }
      : undefined;
  return {
    kind: 'recurring',
    freq: v.repeat,
    interval: Number(v.interval) || 1,
    startDate: v.at.slice(0, 10),
    time: v.at.slice(11, 16),
    ...(v.repeat === 'weekly' && v.weekdays.length ? { weekdays: v.weekdays } : {}),
    ...(v.repeat === 'monthly' && v.monthday !== '' ? { monthday: Number(v.monthday) } : {}),
    ...(v.businessDaysOnly ? { businessDaysOnly: true } : {}),
    ...(quietHours ? { quietHours } : {}),
    ...(end ? { end } : {}),
  };
}

/** UTC-инстант (ISO) → 'ДД.ММ.ГГГГ ЧЧ:ММ' в московском времени. */
export function formatMoscowInstant(utcIso: string): string {
  const local = utcToMoscowLocal(utcIso); // 'YYYY-MM-DDTHH:MM'
  return `${local.slice(8, 10)}.${local.slice(5, 7)}.${local.slice(0, 4)} ${local.slice(11, 16)}`;
}

/** Краткое человекочитаемое описание расписания для таблицы. */
export function describeSpec(spec: ScheduleSpec | null): string {
  if (!spec) return '—';
  if (spec.kind === 'oneoff') return 'Разово';
  if (spec.kind === 'dates') return 'По датам';
  if (spec.kind === 'relative') return 'Перед событием';

  const every = spec.interval > 1 ? `каждые ${spec.interval} ${INTERVAL_UNIT[spec.freq]}` : FREQ_LABEL[spec.freq];
  let detail = '';
  if (spec.freq === 'weekly' && spec.weekdays?.length) {
    detail = ` (${spec.weekdays.slice().sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d]).join(', ')})`;
  } else if (spec.freq === 'monthly' && spec.monthday) {
    detail = ` (${spec.monthday}-е)`;
  }
  let end = '';
  if (spec.end?.type === 'afterN') end = `, ${spec.end.n} раз`;
  else if (spec.end?.type === 'until') end = `, до ${spec.end.until}`;
  let delivery = '';
  if (spec.businessDaysOnly) delivery += ' · будни';
  if (spec.quietHours) delivery += ` · тихо ${spec.quietHours.from}–${spec.quietHours.to}`;
  return `${every}${detail} в ${spec.time}${end}${delivery}`;
}
