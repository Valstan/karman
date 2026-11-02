/**
 * Признаки дампа vault-таблиц (S4, аудит #057 от 03.10).
 *
 * Правила-детекторы в `.gitleaks.toml` искали ЗНАЧЕНИЯ полей (`token_hash = …`,
 * JSON-конверт GCM), а настоящий `pg_dump` отдаёт их иначе:
 *
 * - COPY-форма (обычная): `COPY public.secrets_item (id, …) FROM stdin;` и дальше
 *   строки, разделённые табуляцией. Ни `=`, ни кавычек вокруг значений нет —
 *   правило на `token_hash = "…"` молчало.
 * - `--column-inserts`: `INSERT INTO public.secrets_item (id, …) VALUES (…);` —
 *   значения в одинарных кавычках, JSON-конверта тоже нет.
 *
 * То есть «детектор дампа» был написан не по форме дампа, а по форме полей,
 * и на настоящем дампе не срабатывал. Цена находки — необратимый коммит ПДн
 * в публичный репозиторий.
 *
 * Поэтому детектор здесь — СТРУКТУРНЫЙ: ловится сам факт выгрузки таблицы
 * (`COPY public.<таблица>` / `INSERT INTO public.<таблица>`), а не значения.
 * Значения в дампе зашифрованы, но и шифротекст в публичном git — это утечка
 * структуры и объёма, а сам факт дампа в репозитории — ошибка сама по себе.
 *
 * Важная деталь: `public.` в шаблоне обязателен. `pg_dump` всегда пишет схему,
 * а миграции (`lib/db/migrations/*.sql`) и `scripts/bootstrap.sql` — таблицы без
 * схемы. Без `public.` правило ловило бы собственные миграции и роняло гейт.
 */

/**
 * Таблицы, которые `scripts/backup_vault.sh` выгружает в дамп.
 *
 * Порядок не косметический: в alternation более длинное имя должно идти РАНЬШЕ
 * короткого (`secrets_card_field` до `secrets_card`), иначе короткое съедает
 * префикс длинного. Регекс с явной группой всё равно разбирает такое сам, но
 * полагаться на это в шаблоне, который копируется ещё и в `.gitleaks.toml`,
 * незачем.
 */
export const VAULT_DUMP_TABLES = [
  'secrets_project',
  'secrets_item',
  'secrets_token',
  'secrets_audit',
  'secrets_card_field',
  'secrets_card',
  'secrets_grant_policy',
  'secrets_grant',
  'secrets_bootstrap',
  'passport_issuer',
  'passport_identity',
  'passport_assertion',
  'auth_totp',
  'auth_recovery_code',
  'auth_audit',
  'auth_oidc_identity',
  'person_profile',
  'documents_documentcategory',
  'documents_document',
  'document_field',
  'document_file',
  'circle_member',
  'circle',
  'family_person',
  'family_relation',
  'hotline_message',
  'hotline_presence',
] as const;

const TABLES = VAULT_DUMP_TABLES.join('|');

/** COPY-форма `pg_dump` (обычный дамп). */
export const DUMP_COPY_PATTERN = `COPY\\s+public\\.(${TABLES})\\s*\\(`;

/** `--column-inserts`-форма `pg_dump`. */
export const DUMP_INSERT_PATTERN = `INSERT\\s+INTO\\s+public\\.(${TABLES})\\s*\\(`;

export const DUMP_COPY_REGEX = new RegExp(DUMP_COPY_PATTERN);
export const DUMP_INSERT_REGEX = new RegExp(DUMP_INSERT_PATTERN);

/**
 * Все найденные в тексте признаки выгрузки: вид дампа + имя таблицы.
 * Пустой массив — выгрузки в тексте нет.
 */
export function findDumpMarkers(text: string): { form: 'copy' | 'insert'; table: string }[] {
  const found: { form: 'copy' | 'insert'; table: string }[] = [];
  for (const match of text.matchAll(new RegExp(DUMP_COPY_PATTERN, 'g'))) {
    found.push({ form: 'copy', table: match[1]! });
  }
  for (const match of text.matchAll(new RegExp(DUMP_INSERT_PATTERN, 'g'))) {
    found.push({ form: 'insert', table: match[1]! });
  }
  return found;
}
