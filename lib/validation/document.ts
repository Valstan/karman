import { z } from 'zod';

/**
 * Произвольные поля документа. Набор присылается ЦЕЛИКОМ и заменяет прежний:
 * форма позволяет переименовать, переставить и удалить поля разом, и частичное
 * обновление здесь означало бы догадку о том, какая старая строка какой новой
 * соответствует.
 *
 * Пустое имя отбрасывается на сервере, а не отвергается: человек добавил строку,
 * не заполнил и ушёл сохранять — терять из-за этого весь ввод нельзя.
 */
export const documentFieldsSchema = z.object({
  id: z.coerce.number().int().positive(),
  fields: z
    .array(
      z.object({
        name: z.string().trim().max(100, 'Название поля длиннее 100 символов').default(''),
        value: z.string().trim().max(4000, 'Значение длиннее 4000 символов').default(''),
      }),
    )
    .max(60, 'Больше 60 полей на документ нельзя')
    .default([]),
});

import { optionalDateString } from './common';

export const documentCreateSchema = z.object({
  title: z.string().trim().min(1, 'Введите название').max(200),
  description: z.string().trim().max(2000).optional().default(''),
  documentType: z.string().trim().max(20).optional().default(''),
  documentNumber: z.string().trim().max(100).optional().default(''),
  issueDate: optionalDateString,
  expiryDate: optionalDateString,
  issuingAuthority: z.string().trim().max(200).optional().nullable(),
  isActive: z.coerce.boolean().optional().default(true),
  categoryId: z.coerce.number().int().positive().optional(),
});

export const documentUpdateSchema = documentCreateSchema.partial().extend({
  id: z.coerce.number().int().positive(),
});

export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;
export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>;
