/**
 * Единый список полей карточки человека — ОДИН источник правды для трёх мест:
 * формы «Кто я» в разделе «Документы», экрана круга и выгрузки галочками.
 *
 * Иначе список неизбежно разъедется: добавленное в форму поле не появится в
 * выгрузке, и человек, поставив галочку «всё», получит не всё. Здесь же живёт
 * порядок — он же порядок строк в распечатке.
 *
 * Ключи совпадают с именами колонок в drizzle-схеме (`personProfile`): выгрузка
 * читает значения по ключу, и расхождение имён превратилось бы в пустую строку
 * без ошибки.
 *
 * С 2026-09-04 карточка — только то, что НЕ документ: ФИО, рождение, заметки.
 * СНИЛС, ИНН, адреса, работа и контакты стали документами (миграция 0015) —
 * раздел «Мои данные» держал их рядом с ФИО, а раздел «Документы» предлагал
 * шаблоны с теми же реквизитами, и одно и то же жило в двух местах.
 */

export type ProfileFieldKind = 'text' | 'date' | 'multiline';

export type ProfileField = {
  key: ProfileFieldKey;
  label: string;
  kind: ProfileFieldKind;
  /** Подсказка под полем формы; пусто — подсказка не нужна. */
  hint?: string;
  /** Группа в форме — только для вёрстки, на выгрузку не влияет. */
  group: 'Имя' | 'Рождение' | 'Прочее';
};

export type ProfileFieldKey =
  | 'lastName'
  | 'firstName'
  | 'middleName'
  | 'birthDate'
  | 'birthPlace'
  | 'notes';

export const PROFILE_FIELDS: readonly ProfileField[] = [
  { key: 'lastName', label: 'Фамилия', kind: 'text', group: 'Имя' },
  { key: 'firstName', label: 'Имя', kind: 'text', group: 'Имя' },
  { key: 'middleName', label: 'Отчество', kind: 'text', group: 'Имя' },
  { key: 'birthDate', label: 'Дата рождения', kind: 'date', group: 'Рождение' },
  { key: 'birthPlace', label: 'Место рождения', kind: 'text', group: 'Рождение' },
  {
    key: 'notes',
    label: 'Заметки',
    kind: 'multiline',
    hint: 'Реквизиты — СНИЛС, адреса, телефоны — заводятся документами ниже, а не здесь.',
    group: 'Прочее',
  },
] as const;

export const PROFILE_FIELD_KEYS: readonly ProfileFieldKey[] = PROFILE_FIELDS.map((f) => f.key);

/** Значения карточки: ключ поля → строка. Пусто — значит поле не заполнено. */
export type ProfileValues = Record<ProfileFieldKey, string>;

/**
 * Пустая карточка — ВЫВОДИТСЯ из списка полей, а не пишется рядом руками.
 * Форма всегда получает полный набор ключей: `react-hook-form` на undefined
 * делает поле неуправляемым, а React ругается на переход controlled→uncontrolled
 * ровно в тот момент, когда человек начинает печатать.
 */
export function emptyProfile(): ProfileValues {
  return Object.fromEntries(PROFILE_FIELD_KEYS.map((k) => [k, ''])) as ProfileValues;
}

const LABELS: Record<string, string> = Object.fromEntries(
  PROFILE_FIELDS.map((f) => [f.key, f.label]),
);

/** Человекочитаемое имя поля; неизвестный ключ возвращается как есть. */
export function profileFieldLabel(key: string): string {
  return LABELS[key] ?? key;
}

/**
 * Как называть человека на экранах: ФИО из карточки, а если она пуста — логин.
 * Логин здесь именно запасной вариант: в круге родня узнаёт друг друга по имени,
 * а «chaka» в списке участников не говорит ничего.
 */
export function displayName(profile: ProfileValues, fallback: string): string {
  const full = [profile.lastName, profile.firstName, profile.middleName]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return full === '' ? fallback : full;
}

/** Группы в порядке появления — для вёрстки формы. */
export function profileFieldGroups(): { group: ProfileField['group']; fields: ProfileField[] }[] {
  const out: { group: ProfileField['group']; fields: ProfileField[] }[] = [];
  for (const field of PROFILE_FIELDS) {
    const last = out[out.length - 1];
    if (last && last.group === field.group) last.fields.push(field);
    else out.push({ group: field.group, fields: [field] });
  }
  return out;
}

/**
 * Значение поля в виде строки для показа и выгрузки. Дата приводится к
 * привычному виду 31.12.1980 — ISO в распечатке для человека нечитаем, а
 * `toLocaleDateString` здесь неприменим: он зависит от часового пояса, и
 * `1980-12-31` западнее Москвы превратится в 30 декабря.
 */
export function formatProfileValue(kind: ProfileFieldKind, value: string | null): string {
  const raw = (value ?? '').trim();
  if (raw === '') return '';
  if (kind !== 'date') return raw;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : raw;
}
