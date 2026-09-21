import { z } from 'zod';

const short = (max: number, what: string) => z.string().trim().max(max, `${what} — длиннее ${max} символов`).default('');

/**
 * Человек древа. Все поля необязательны, кроме того, что хоть что-то из имени
 * или прозвища должно быть: безымянный узел на бумаге — пустой прямоугольник.
 * Даты — строкой: «1952», «около 1900», «12.03.1985» — всё законно.
 */
export const familyPersonSchema = z
  .object({
    lastName: short(150, 'Фамилия'),
    firstName: short(150, 'Имя'),
    middleName: short(150, 'Отчество'),
    maidenName: short(150, 'Девичья фамилия'),
    nickname: short(150, 'Как зовут в семье'),
    sex: z.enum(['m', 'f', '']).default(''),
    born: short(100, 'Рождение'),
    birthPlace: short(500, 'Место рождения'),
    died: short(100, 'Смерть'),
    deathPlace: short(500, 'Место смерти'),
    residence: short(500, 'Где жил'),
    occupation: short(1000, 'Род занятий'),
    nationality: short(100, 'Национальность'),
    surnameMeaning: short(2000, 'Значение фамилии'),
    notes: short(4000, 'Заметки'),
    holder: short(150, 'Чей документ'),
    isSelf: z.coerce.boolean().default(false),
  })
  .refine((p) => p.lastName !== '' || p.firstName !== '' || p.nickname !== '', {
    message: 'Впишите хотя бы имя или как зовут в семье',
    path: ['firstName'],
  });

export const familyPersonUpdateSchema = z.object({
  id: z.coerce.number().int().positive(),
  person: familyPersonSchema,
});

/**
 * Создание с необязательной связью к уже существующему человеку — так «добавить
 * ребёнка» делается одним нажатием, а не «создать, потом связать».
 */
export const familyPersonCreateSchema = z.object({
  person: familyPersonSchema,
  link: z
    .object({
      /** К кому привязать нового. */
      anchorId: z.coerce.number().int().positive(),
      /** Кем новый приходится якорю. */
      as: z.enum(['parent', 'child', 'spouse']),
    })
    .optional(),
});

export const familyRelationSchema = z.object({
  kind: z.enum(['parent', 'spouse']),
  fromId: z.coerce.number().int().positive(),
  toId: z.coerce.number().int().positive(),
  note: short(200, 'Пометка'),
});

export const idSchema = z.object({ id: z.coerce.number().int().positive() });

export type FamilyPersonInput = z.infer<typeof familyPersonSchema>;
export type FamilyPersonCreateInput = z.infer<typeof familyPersonCreateSchema>;
export type FamilyRelationInput = z.infer<typeof familyRelationSchema>;
