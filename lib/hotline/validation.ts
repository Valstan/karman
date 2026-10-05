import { z } from 'zod';

/**
 * Контракт relay Телефона (v2-a). Зеркало Ф0 с серверной строгостью:
 * виды и лимит 2000 — те же, что `TEXT_LIMIT` и виды в общем `hotline.sh`.
 */

/** Метка участника: канонические из почты (`KARMAN`, `setka`, …). */
export const hotlineLabel = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'метка: латиница, цифры, - и _, с буквы, до 64');

/**
 * Комната: пара `to-<метка>`, общая `all`, ad-hoc `room:<имя>` (3–4 участника).
 * Ф0-шный `broadcast` сюда не входит: клиент при dual-write маппит его в `all`.
 */
export const hotlineRoom = z
  .string()
  .trim()
  .regex(
    /^(all|to-[A-Za-z0-9_-]{1,60}|room:[A-Za-z0-9_-]{1,60})$/,
    'комната: all, to-<метка> или room:<имя>',
  );

/** Виды Ф0 + `ack` из v1.2 («принял, отвечу через ~N», срок несёт текст). */
export const hotlineKind = z.enum(['question', 'answer', 'done', 'ping', 'wakeup', 'ack']);

/** Текст как есть, без trim: лимит — часть контракта, сервер его не расширяет. */
export const hotlineText = z.string().min(1, 'текст пуст').max(2000, 'лимит ленты — 2000 символов');

export const hotlinePostSchema = z.object({
  from: hotlineLabel,
  room: hotlineRoom,
  kind: hotlineKind,
  text: hotlineText,
});

export const hotlineReadSchema = z.object({
  room: hotlineRoom,
  since_id: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const hotlinePresenceSchema = z.object({
  label: hotlineLabel,
  /** Минуты, как в `presence --alive 60` («я в чате на час»). */
  alive_minutes: z.coerce.number().int().min(1).max(1440),
  /**
   * Событие линии (сторож, мандат 05.10): снятие трубки — 'on_line', отбой —
   * 'offline'. Опционально намеренно (G54): тик БЕЗ поля — обычный heartbeat,
   * состояние не трогает; тик С полем — событие. Сервер никогда не выводит
   * состояние из частоты тиков, кроме авто-отбоя после двух пропусков.
   */
  line_state: z.enum(['offline', 'on_line']).optional(),
});

export type HotlineLineState = z.infer<typeof hotlinePresenceSchema>['line_state'];

export type HotlinePost = z.infer<typeof hotlinePostSchema>;
export type HotlineKind = z.infer<typeof hotlineKind>;
