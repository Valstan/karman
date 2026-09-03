/**
 * Состояние участия в круге — чистая функция без БД, поэтому её можно проверить
 * тестом. Это важнее, чем кажется: от неё зависит, увидит ли один человек
 * паспортные данные другого, а харнесса с базой в проекте пока нет (R1).
 */

export type MemberState = 'consented' | 'invited' | 'declined' | 'left' | 'removed';

export type MemberStamps = {
  consentedAt: string | null;
  declinedAt: string | null;
  leftAt: string | null;
  /** Исключён владельцем — не то же самое, что ушёл сам. */
  removedAt: string | null;
};

/**
 * Порядок проверок = порядок важности событий, и он НЕ произволен:
 *
 *  - `removedAt` важнее всего: исключение — чужое решение, и человек не должен
 *    иметь возможности его отменить. Пока эта метка не отличалась от `leftAt`,
 *    исключённый возвращал себе доступ кнопкой «Вернуться» (разбор 2026-09-04).
 *  - `leftAt` следующий: вышедший когда-то согласился, и `consentedAt` у него
 *    остался непустым. Проверь согласие раньше — и вышедший навсегда останется
 *    «участвует», то есть его данные будут видны после того, как он их закрыл.
 *  - `consentedAt` важнее отказа: отказавшийся мог передумать и войти, при этом
 *    `declinedAt` в истории остаётся.
 *  - остальное — приглашён и ещё не ответил.
 *
 * Само по себе состояние доступа НЕ даёт: видимость считает `visiblePeopleIds`
 * запросом, где условие «согласился, не вышел и не исключён» стоит в SQL. Эта
 * функция — для показа человеку, и расхождение между ней и запросом было бы
 * враньём интерфейса, поэтому условия обязаны совпадать.
 */
export function memberState(stamps: MemberStamps): MemberState {
  if (stamps.removedAt) return 'removed';
  if (stamps.leftAt) return 'left';
  if (stamps.consentedAt) return 'consented';
  if (stamps.declinedAt) return 'declined';
  return 'invited';
}

/** Видит ли этот участник данные круга (и виден ли сам). */
export function memberIsActive(stamps: MemberStamps): boolean {
  return memberState(stamps) === 'consented';
}

/**
 * Может ли человек войти в круг САМ, без нового приглашения. Отказавшийся и
 * ушедший — могут (это их же решение), исключённый — нет.
 */
export function canRejoinBySelf(stamps: MemberStamps): boolean {
  const state = memberState(stamps);
  return state === 'invited' || state === 'declined' || state === 'left';
}
