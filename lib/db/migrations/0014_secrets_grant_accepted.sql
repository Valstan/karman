-- 0014_secrets_grant_accepted — двусторонний grant (мандат brain 2026-09-03, D-061).
--
-- РУКОПИСНАЯ миграция (KARMAN не гоняет drizzle-kit generate). Аддитивно: одна
-- колонка и замена частичного уникального индекса. Применяется на проде через
-- psql ДО деплоя (migration-guard в deploy-prod.yml заблокирует авто-деплой →
-- деплой через workflow_dispatch).
--
-- Зачем. Машинная выдача по токену комнаты-источника была закрыта 2026-09-03:
-- она писала ИМЯ ключа в чужое пространство имён без согласия получателя
-- (docs/passport-server.md → «Границы v1»). Условие возврата — согласие цели:
-- источник ПРЕДЛАГАЕТ выдачу своим токеном, получатель ПРИНИМАЕТ своим.
-- Предложение — строка с accepted_at IS NULL: получатель её не видит в
-- GET /api/secrets, значение по ней не отдаётся, имя не занято.
--
-- Выдача владельцем из GUI принимается сразу (владелец — полномочие над обеими
-- комнатами), поэтому все существующие строки помечаются принятыми задним числом:
-- все они и были выданы владельцем (аудит: actor owner:1).

BEGIN;

ALTER TABLE secrets_grant ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
COMMENT ON COLUMN secrets_grant.accepted_at IS
  'Согласие получателя: NULL — предложение источника, ещё не принято (в выдачу не входит). Владелец из GUI принимает сразу.';

UPDATE secrets_grant SET accepted_at = created_at WHERE accepted_at IS NULL;

-- Имя у получателя занимает только ПРИНЯТАЯ действующая выдача. Предложения
-- имя не резервируют: иначе чужая комната могла бы «застолбить» имя у
-- получателя одним POST'ом, не спрашивая. Два предложения на одно имя возможны;
-- второе принять не выйдет — индекс ответит 409 на accept.
DROP INDEX IF EXISTS secrets_grant_target_alias_uq;
CREATE UNIQUE INDEX IF NOT EXISTS secrets_grant_target_alias_uq
  ON secrets_grant (target_project_id, alias_key)
  WHERE revoked_at IS NULL AND accepted_at IS NOT NULL;

COMMIT;
