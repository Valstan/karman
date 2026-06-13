import type { ScheduleSpec } from './types';

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
};

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
      ...endFields,
    };
  }
  // dates / relative — форма их не редактирует (P4/позже)
  return { repeat: 'none', interval: 1, weekdays: [], ...endFields };
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
  return `${every}${detail} в ${spec.time}${end}`;
}
