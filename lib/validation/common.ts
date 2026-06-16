import { z } from 'zod';

/**
 * Денежное значение остаётся СТРОКОЙ (конвенция numeric → string).
 * Принимаем число или строку, нормализуем в `"123.45"`.
 */
export const money = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v.trim()))
  .refine((v) => /^\d+([.,]\d{1,2})?$/.test(v), 'Неверная сумма')
  .transform((v) => v.replace(',', '.'));

// `.optional()` — чтобы ключ объекта можно было ОПУСТИТЬ целиком. В Zod v4 (в отличие
// от v3) union-с-`z.undefined()` НЕ делает ключ опциональным: отсутствующий ключ даёт
// «expected nonoptional». Финальный `.transform(v ?? null)` возвращает absent → null,
// сохраняя контракт (пусто/отсутствие → null, выход остаётся `string | null`). G54/G70.
export const optionalMoney = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined || v === '' ? null : typeof v === 'number' ? v.toString() : v.trim()))
  .refine((v) => v === null || /^\d+([.,]\d{1,2})?$/.test(v), 'Неверная сумма')
  .transform((v) => (v === null ? null : v.replace(',', '.')))
  .optional()
  .transform((v) => v ?? null);

/** Дата в формате YYYY-MM-DD (строкой, без таймзонных конверсий). */
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Неверная дата');

// См. примечание у `optionalMoney`: `.optional()` делает ключ опускаемым (Zod v4),
// финальный `.transform(v ?? null)` держит контракт absent/пусто → null.
export const optionalDateString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined || v === '' ? null : v))
  .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Неверная дата')
  .optional()
  .transform((v) => v ?? null);
