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

export const optionalMoney = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined || v === '' ? null : typeof v === 'number' ? v.toString() : v.trim()))
  .refine((v) => v === null || /^\d+([.,]\d{1,2})?$/.test(v), 'Неверная сумма')
  .transform((v) => (v === null ? null : v.replace(',', '.')));

/** Дата в формате YYYY-MM-DD (строкой, без таймзонных конверсий). */
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Неверная дата');

export const optionalDateString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined || v === '' ? null : v))
  .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Неверная дата');
