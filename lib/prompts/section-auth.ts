import { timingSafeEqual } from 'node:crypto';
import { runtimeSecret } from '@/lib/ecosystem/runtime-secrets';

/**
 * Машинный доступ ПРОЕКТА к своему разделу библиотеки промтов.
 *
 * Заказ владельца (2026-11-08): «научи проекты ходить в Карман и проверять
 * промты для их проектов, чтобы каждый проект видел именно свои промты, те,
 * которые не в архиве, новые, и умел забирать их вместе с готовыми планами,
 * анализировать их уже на основе своих предпочтений и подправлять план, если
 * необходимо, и выполнять задания… и как-то надо, чтобы эти промты и планы
 * отправлять в архив после их выполнения, автоматически».
 *
 * Почему отдельный секрет на раздел, а не общий `PROMPTS_INGEST_SECRET`:
 * тот — ПИСАТЕЛЬ (Мозг складывает надиктованные промты по разделам). Здесь —
 * ЧИТАТЕЛЬ: проект забирает СВОИ промты и архивирует выполненные. Право на
 * раздел даёт токен этого раздела: видно ровно свой раздел и ничего больше.
 *
 * Fail-closed, как остальные каналы: секрет раздела не задан — 503
 * («не настроено»), чужой токен — 403 (не 401: токен есть, но не на этот раздел).
 */

/**
 * Имя секрета раздела: `PROMPTS_TOKEN_<SECTION>`.
 * Каноническое имя раздела — латиница (`docs/PROJECT_NAMES.md` в Мозге):
 * `MatricaRMZ` → `PROMPTS_TOKEN_MATRICARMZ`, `SARAFAN` → `PROMPTS_TOKEN_SARAFAN`.
 */
export function sectionSecretName(section: string): string {
  const cleaned = String(section ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  return `PROMPTS_TOKEN_${cleaned}`;
}

/** Constant-time сравнение строк; разной длины — сразу false. */
export function secretsEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Раздел по токену: токен должен совпасть с секретом ИМЕННО ЭТОГО раздела.
 *
 * Раздел приходит в запросе — и токен служит ему доказательством. Обойти
 * нельзя: подставить чужой раздел нельзя (секрет другого раздела не совпадёт).
 */
export async function resolveSectionByToken(
  authHeader: string | null | undefined,
  section: string | null | undefined,
): Promise<
  | { ok: true; section: string }
  | { ok: false; reason: 'not_configured' | 'unauthorized' }
> {
  const clean = String(section ?? '').trim();
  if (!clean) {
    return { ok: false, reason: 'unauthorized' };
  }
  const expected = await runtimeSecret(sectionSecretName(clean));
  if (!expected) {
    return { ok: false, reason: 'not_configured' };
  }
  const prefix = 'Bearer ';
  if (!authHeader || !authHeader.startsWith(prefix)) {
    return { ok: false, reason: 'unauthorized' };
  }
  if (!secretsEqual(authHeader.slice(prefix.length), expected)) {
    return { ok: false, reason: 'unauthorized' };
  }
  return { ok: true, section: clean };
}
