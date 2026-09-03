/**
 * Состояние участия в круге — чистая функция без БД, поэтому её можно проверить
 * тестом. Это важнее, чем кажется: от неё зависит, увидит ли один человек
 * паспортные данные другого, а харнесса с базой в проекте пока нет (R1).
 */

export type MemberState = 'consented' | 'invited' | 'declined' | 'left';

export type MemberStamps = {
  consentedAt: string | null;
  declinedAt: string | null;
  leftAt: string | null;
};

/**
 * Порядок проверок = порядок событий, и он НЕ произволен:
 *
 *  - `leftAt` важнее всего: человек, вышедший из круга, когда-то согласился,
 *    и `consentedAt` у него остался непустым. Проверь согласие первым — и
 *    вышедший навсегда останется «участвует».
 *  - `consentedAt` важнее отказа: отказавшийся мог передумать и войти, при
 *    этом `declinedAt` в истории остаётся.
 *  - остальное — приглашён и ещё не ответил.
 *
 * Само по себе состояние доступа НЕ даёт: видимость считает `visiblePeopleIds`
 * запросом, где условие «согласился и не вышел» стоит в SQL. Эта функция —
 * для показа человеку, и расхождение между ней и запросом было бы враньём
 * интерфейса, поэтому условия обязаны совпадать.
 */
export function memberState(stamps: MemberStamps): MemberState {
  if (stamps.leftAt) return 'left';
  if (stamps.consentedAt) return 'consented';
  if (stamps.declinedAt) return 'declined';
  return 'invited';
}

/** Видит ли этот участник данные круга (и виден ли сам). */
export function memberIsActive(stamps: MemberStamps): boolean {
  return memberState(stamps) === 'consented';
}
