import { z } from 'zod';

export const bankCreateSchema = z.object({
  name: z.string().trim().min(1, 'Введите название').max(200),
  address: z.string().trim().max(2000).optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(),
  email: z.string().trim().max(254).optional().nullable(),
  website: z.string().trim().max(200).optional().nullable(),
});

export const bankUpdateSchema = bankCreateSchema.partial().extend({
  id: z.coerce.number().int().positive(),
});

export type BankCreateInput = z.infer<typeof bankCreateSchema>;
export type BankUpdateInput = z.infer<typeof bankUpdateSchema>;
