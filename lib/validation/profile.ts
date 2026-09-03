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
  // СНИЛС и ИНН — строки документа, а не числа: пробелы и дефисы значимы,
  // и приводить их к «только цифры» значило бы терять форму записи.
  snils: shortText(20),
  inn: shortText(20),
  registrationAddress: shortText(2000),
  actualAddress: shortText(2000),
  employer: shortText(2000),
  jobTitle: shortText(2000),
  phone: shortText(30),
  email: shortText(254),
  notes: shortText(4000),
});

// Типа-алиаса `ProfileUpsertInput` здесь нет намеренно: форма значений живёт в
// `lib/profile/fields.ts` (`ProfileValues`), и второй синоним того же типа —
// это тот самый born-unused, который проект уже трижды вычищал. Алиас заводится
// по факту импорта, а не «для симметрии».
