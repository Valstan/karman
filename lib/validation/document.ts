import { z } from 'zod';
import { optionalDateString } from './common';

export const documentCreateSchema = z.object({
  title: z.string().trim().min(1, 'Введите название').max(255),
  documentType: z.string().trim().max(50).optional().default(''),
  documentNumber: z.string().trim().max(100).optional().default(''),
  issueDate: optionalDateString,
  expiryDate: optionalDateString,
  issuingAuthority: z.string().trim().max(255).optional().nullable(),
  isActive: z.coerce.boolean().optional().default(true),
});

export const documentUpdateSchema = documentCreateSchema.partial().extend({
  id: z.coerce.number().int().positive(),
});

export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;
export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>;
