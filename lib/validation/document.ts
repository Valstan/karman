import { z } from 'zod';
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
