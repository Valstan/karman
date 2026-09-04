import { z } from 'zod';

/**
 * Карточка человека. Все поля необязательны и по умолчанию пусты: карточка
 * заполняется постепенно, и форма, где обязательна хотя бы фамилия, заставила
 * бы человека выдумывать данные ради сохранения телефона.
 *
 * `.default('')` стоит у КАЖДОГО поля намеренно — по G70 в Zod v4 отсутствующий
 * ключ не становится опциональным сам, а форма присылает только то, что
 * отрисовала.
 */

const shortText = (max: number) => z.string().trim().max(max).default('');

/** Пустая строка или ISO-дата: `<input type="date">` пустым присылает ''. */
const optionalDate = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Некорректная дата')
  .default('');

export const profileUpsertSchema = z.object({
  lastName: shortText(150),
  firstName: shortText(150),
  middleName: shortText(150),
  birthDate: optionalDate,
  birthPlace: shortText(2000),
  // СНИЛС, ИНН, адреса, работа и контакты с 0015 — документы, не карточка.
  notes: shortText(4000),
});

// Типа-алиаса `ProfileUpsertInput` здесь нет намеренно: форма значений живёт в
// `lib/profile/fields.ts` (`ProfileValues`), и второй синоним того же типа —
// это тот самый born-unused, который проект уже трижды вычищал. Алиас заводится
// по факту импорта, а не «для симметрии».
