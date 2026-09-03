import { z } from 'zod';

/** Валидация менеджера секретов. */

export const secretProjectCreateSchema = z.object({
  name: z.string().trim().min(1, 'Введите название').max(200),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/, 'Слаг: латиница в нижнем регистре, цифры, дефис'),
});

export const secretProjectUpdateSchema = secretProjectCreateSchema.extend({
  id: z.coerce.number().int().positive(),
});

// Имя ключа в стиле env-переменной (переиспользуется в UI-upsert и в push-по-токену).
const secretKeyName = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Ключ: буквы/цифры/_, начинается с буквы или _')
  .max(200);
const secretValue = z.string().min(1, 'Пустое значение').max(65536, 'Слишком большое значение (макс 64 КБ)');

export const secretItemUpsertSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  key: secretKeyName,
  value: secretValue,
});

export const secretTokenCreateSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, 'Введите название токена').max(200),
  // read-write токен (проект сможет писать секреты). По умолчанию read-only.
  canWrite: z.coerce.boolean().optional().default(false),
});

// --- Карточки секретов (vault Ф1) -------------------------------------------

// Значение поля карточки: без обрезания длинных ключей/JWT/сертификатов —
// кап 256 КБ только как анти-abuse (требование ADR-0006 «не обрезать»).
const cardFieldValue = z
  .string()
  .min(1, 'Пустое значение')
  .max(262144, 'Слишком большое значение (макс 256 КБ)');

export const secretCardCreateSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  title: z.string().trim().min(1, 'Введите наименование').max(500),
  // Программное обозначение (как в env прода); пусто — личная карточка без env-связки.
  envKey: secretKeyName.optional().or(z.literal('').transform(() => undefined)),
});

export const secretCardUpdateSchema = secretCardCreateSchema
  .omit({ projectId: true })
  .extend({ id: z.coerce.number().int().positive() });

export const secretCardFieldUpsertSchema = z.object({
  cardId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, 'Введите имя поля').max(200),
  kind: z.enum(['text', 'secret', 'url']).default('text'),
  value: cardFieldValue,
});

/** Импорт карточек из CSV (vault Ф3). Кап 8 МБ на файл (анти-abuse). */
export const secretCardImportSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  csv: z.string().min(1, 'Пустой файл').max(8 * 1024 * 1024, 'Файл слишком большой (макс 8 МБ)'),
});

/**
 * Выдача доступа к ключу другой комнате (мандат brain 2026-07-26). Значение не
 * копируется: получатель читает ключ источника под именем aliasKey (по умолчанию —
 * то же имя). note — кто инициатор выдачи, уходит в аудит обеих комнат.
 */
export const secretGrantCreateSchema = z
  .object({
    sourceProjectId: z.coerce.number().int().positive(),
    sourceKey: secretKeyName,
    targetProjectId: z.coerce.number().int().positive(),
    aliasKey: secretKeyName.optional().or(z.literal('').transform(() => undefined)),
    note: z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined)),
  })
  .refine((v) => v.sourceProjectId !== v.targetProjectId, {
    message: 'Комната-источник и комната-получатель совпадают',
    path: ['targetProjectId'],
  });

/**
 * Тело POST /api/secrets/grants — выдача доступа машинным путём (D-061, второй ход):
 * токен комнаты-ИСТОЧНИКА выдаёт свой ключ комнате target_slug. note обязателен —
 * это «основание» (номер решения Мозга или причина), оно уходит в аудит обеих комнат.
 */
export const secretGrantApiCreateSchema = z.object({
  key: secretKeyName,
  target_slug: secretProjectCreateSchema.shape.slug,
  alias: secretKeyName.optional().or(z.literal('').transform(() => undefined)),
  note: z.string().trim().min(1, 'Основание обязательно (номер решения или причина выдачи)').max(500),
});

/** Тело DELETE /api/secrets/grants — отзыв выдачи тем же токеном комнаты-источника. */
export const secretGrantApiRevokeSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Тело POST /api/secrets/provision — self-serve onboarding комнаты (мандат brain
 * 2026-07-12). name опционально: по умолчанию совпадает со slug.
 */
export const secretProvisionSchema = z.object({
  slug: secretProjectCreateSchema.shape.slug,
  name: z.string().trim().min(1).max(200).optional(),
});

/**
 * Выпуск времянки — одноразового bootstrap-кода комнаты (задача владельца
 * 2026-08-10). Срок зажимается в сервисе (`clampTtlMinutes`), поэтому здесь
 * достаточно числа: форма может прислать пустую строку, и падать на этом незачем.
 */
export const secretBootstrapCreateSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  ttlMinutes: z.coerce.number().optional().default(30),
  canWrite: z.coerce.boolean().optional().default(false),
  note: z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined)),
});

/** Тело POST /api/secrets — машинная запись секретов по токену (bulk upsert). */
export const secretPushSchema = z.object({
  secrets: z
    .record(secretKeyName, secretValue)
    .refine((m) => Object.keys(m).length >= 1, 'Пустой набор секретов')
    .refine((m) => Object.keys(m).length <= 200, 'Слишком много ключей за раз (макс 200)'),
});

// Алиасы заводим ПО ФАКТУ импорта, а не «по одному на схему»: симметрия здесь
// соблазнительна, но каждый неиспользованный алиас потом всплывает в deadcode.
// Так уже вышло трижды — `SecretPushInput` (удалён 07-10), `SecretCardImportInput`
// и `SecretProvisionInput` (удалены 08-10). Нужен тип у новой схемы — допиши строку.
export type SecretProjectCreateInput = z.infer<typeof secretProjectCreateSchema>;
export type SecretProjectUpdateInput = z.infer<typeof secretProjectUpdateSchema>;
export type SecretItemUpsertInput = z.infer<typeof secretItemUpsertSchema>;
export type SecretTokenCreateInput = z.infer<typeof secretTokenCreateSchema>;
export type SecretCardCreateInput = z.infer<typeof secretCardCreateSchema>;
export type SecretCardUpdateInput = z.infer<typeof secretCardUpdateSchema>;
export type SecretCardFieldUpsertInput = z.infer<typeof secretCardFieldUpsertSchema>;
export type SecretGrantCreateInput = z.infer<typeof secretGrantCreateSchema>;
export type SecretGrantApiCreateInput = z.infer<typeof secretGrantApiCreateSchema>;
export type SecretBootstrapCreateInput = z.infer<typeof secretBootstrapCreateSchema>;
