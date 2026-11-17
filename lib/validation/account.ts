import { z } from 'zod';

/**
 * Валидация мультиаккаунта (задача владельца 2026-11-03): аккаунты внешних
 * сервисов, которыми владелец переключается, пока программирует.
 *
 * Пароль — обязательный при создании (он копируется в сервис, куда владелец
 * входит). Токены за активацию — необязательные: владелец вносит их, если
 * знает расход; без них статистика по проектам считает только активации.
 */

export const accountCreateSchema = z.object({
  title: z.string().trim().max(200, 'Слишком длинное название').optional().default(''),
  email: z
    .string()
    .trim()
    .min(3, 'Укажите почту')
    .max(320, 'Слишком длинная почта')
    .email('Почта выглядит неверно'),
  password: z.string().min(1, 'Укажите пароль').max(200, 'Слишком длинный пароль'),
});

export const accountUpdateSchema = z.object({
  id: z.coerce.number().int().positive(),
  title: z.string().trim().max(200, 'Слишком длинное название').optional(),
  email: z
    .string()
    .trim()
    .min(3, 'Укажите почту')
    .max(320, 'Слишком длинная почта')
    .email('Почта выглядит неверно')
    .optional(),
  password: z.string().min(1, 'Укажите пароль').max(200, 'Слишком длинный пароль').optional(),
  /**
   * Проект аккаунта: можно переключить на другой или снять (null).
   * undefined — «не меняю» (правка названия не должна затирать проект).
   */
  projectId: z.coerce.number().int().positive().nullable().optional(),
});

/** Активация аккаунта: гасит его на 5 часов (только явная кнопка «Активировать»). */
export const accountActivateSchema = z.object({
  id: z.coerce.number().int().positive(),
  /** Проект, на который уходят токены этого аккаунта (может быть не указан). */
  projectId: z.coerce.number().int().positive().nullable().optional(),
  /** Токены за эту активацию; undefined — «не меняю». */
  tokens: z.coerce.number().int().min(0, 'Токены не могут быть отрицательными').max(100_000_000).optional(),
  /**
   * Номер активации в неделе аккаунта (1..7) — по нему считаются очки
   * (заказ владельца 07.11: 4-я и 7-я активации — 1000 очков, остальные —
   * 400). undefined — «определи сам», по недельной квоте аккаунта.
   */
  activationIndex: z.coerce.number().int().min(1, 'Номер активации — от 1 до 7').max(7, 'Номер активации — от 1 до 7').optional(),
});

/**
 * Правка номера активации уже записанного дня (заказ владельца 08.11).
 *
 * Номер — это клетка недели аккаунта на панели MiniMax (1..7). Владелец
 * называет его руками, когда программа ошиблась; очки пересчитываются по нему.
 */
export const accountActivationIndexSchema = z.object({
  id: z.coerce.number().int().positive(),
  activationIndex: z.coerce
    .number()
    .int()
    .min(1, 'Номер активации — от 1 до 7')
    .max(7, 'Номер активации — от 1 до 7'),
});

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1, 'Укажите название проекта').max(200, 'Слишком длинное название'),
});

/**
 * Запись активации от проекта (машинный доступ к пулу MiniMax, 13.11).
 *
 * - `account_id` — какой аккаунт отработан;
 * - `points` — фактические очки с панели MiniMax (необязательно: если не прислали,
 *   считаем по клетке сами);
 * - `activation_index` — номер клетки, который ПРОЕКТ увидел на панели (1..7).
 *   Это независимое показание: при расхождении с нашим предсказанием оно попадает в
 *   журнал как истина, а расхождение помечается.
 *
 * Проекта и даты в теле нет: проект — это токен, кто звал, а дата — московская дата
 * сервера. Клиентский клок не авторитет.
 */
/**
 * Наблюдение потребителя по выданному токену (машинный доступ к пулу MiniMax).
 *
 * - `account_id` — какой аккаунт отработан (внутренний id Кармана); `email` — тот же
 *   аккаунт ПОЧТОЙ (проект не обязан знать наши внутренние id). Если заданы оба — они
 *   должны указывать на один аккаунт, иначе 400.
 * - `points` — сколько очков фактически было на токене (факт панели MiniMax);
 * - `activation_index` — номер клетки, который потребитель увидел на панели (1..7).
 *
 * Наблюдение — это истина, а не управление учётом: активацию, окно и статистику ведём
 * мы. Пара токенов сюда НЕ принимается: цепочка одноразовых refresh'ей — наша.
 */
export const minimaxObservationSchema = z
  .object({
    account_id: z.coerce.number().int().positive().optional(),
    email: z.string().trim().min(3, 'Укажите почту').max(320, 'Слишком длинная почта').optional(),
    points: z.coerce.number().int().min(0, 'Очки не могут быть отрицательными').max(100_000).optional(),
    activation_index: z.coerce.number().int().min(1, 'Номер активации — от 1 до 7').max(7, 'Номер активации — от 1 до 7').optional(),
  })
  .refine((value) => value.account_id !== undefined || value.email !== undefined, {
    message: 'Нужен account_id или email аккаунта',
  });

/**
 * Продление цепочки токенов аккаунта (D-219, мандат владельца 17.11).
 *
 * Проект просит у нас **свежий access того же аккаунта**, который мы ему уже
 * выдали: его access истёк (вендорские 12 часов), а новый вход — это два минуты
 * ручной работы владельца в браузере. Продлеваем цепочку мы, refresh наружу не
 * уходит никогда.
 *
 * - `account_id` — какой аккаунт (внутренний id Кармана); `email` — тот же
 *   аккаунт ПОЧТОЙ (проект не обязан знать наши внутренние id). Если заданы оба —
 *   они должны указывать на один аккаунт.
 * - Никаких полей про токены: пару мы не принимаем и не отдаём.
 */
export const minimaxRenewSchema = z
  .object({
    account_id: z.coerce.number().int().positive().optional(),
    email: z.string().trim().min(3, 'Укажите почту').max(320, 'Слишком длинная почта').optional(),
  })
  .refine((value) => value.account_id !== undefined || value.email !== undefined, {
    message: 'Нужен account_id или email аккаунта',
  });

export type AccountCreateInput = z.infer<typeof accountCreateSchema>;
export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;

/**
 * Кто инициировал активацию аккаунта.
 *
 * - `owner` — владелец нажал кнопку «Активировать» в панели (свой расход на
 *   программирование);
 * - `api` — проект запросил активацию по HTTP (`POST /api/minimax/activations`),
 *   например Сарафан на волне постов ВК.
 *
 * Метка живёт в журнале (`accounts_usage.source`, миграция 0033): по имени проекта
 * расход не разделить — у владельца «САРАФАН» (кириллица), у комнаты «SARAFAN»
 * (латиница), разница в один символ.
 */
export type AccountUsageSource = 'owner' | 'api';

export type AccountActivateInput = z.infer<typeof accountActivateSchema> & {
  /**
   * Инициатор активации. В UI владельца это всегда `owner` (кнопка), а `api` ставит
   * только сервис машинного доступа — из браузера метку не подделать.
   */
  source?: AccountUsageSource;
};
export type AccountActivationIndexInput = z.infer<typeof accountActivationIndexSchema>;
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type MinimaxObservationInput = z.infer<typeof minimaxObservationSchema>;
export type MinimaxRenewInput = z.infer<typeof minimaxRenewSchema>;
