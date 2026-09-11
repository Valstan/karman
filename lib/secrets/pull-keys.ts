/**
 * Разбор `?key=` у `GET /api/secrets` (G331, письмо brain 2026-09-08).
 *
 * Потребитель, получивший от bootstrap'а ноль ключей, и потребитель, которому ноль
 * и полагается, раньше получали один и тот же ответ — `200 {"secrets":{}}`. Дальше
 * любой его вывод «такого секрета у нас нет» опирался на невыясненное. Лечение —
 * дать потребителю сказать, ЧТО он ожидает: `?key=A&key=B` или `?key=A,B`; промах
 * любого из перечисленных — `404` с полем `missing`. Молчание остаётся только для
 * запроса без `key` (ожидалось «что есть»).
 */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type PullKeys =
  | { ok: true; keys: string[] | undefined }
  | { ok: false; error: string };

/** Возвращает список ожидаемых ключей (undefined — вся комната) или ошибку разбора. */
export function parsePullKeys(params: URLSearchParams): PullKeys {
  const raw = params.getAll('key').flatMap((v) => v.split(',')).map((v) => v.trim());
  if (raw.length === 0) {
    return { ok: true, keys: undefined };
  }
  const keys = Array.from(new Set(raw.filter((k) => k.length > 0)));
  if (keys.length === 0) {
    return { ok: false, error: 'Пустое имя ключа в key' };
  }
  const bad = keys.find((k) => !KEY_RE.test(k));
  if (bad !== undefined) {
    return { ok: false, error: `Недопустимое имя ключа: ${bad}` };
  }
  if (keys.length > 200) {
    return { ok: false, error: 'Слишком много ключей в key (максимум 200)' };
  }
  return { ok: true, keys };
}
