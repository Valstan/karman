-- 0003_secrets_token_write — флаг записи у токенов менеджера секретов.
--
-- РУКОПИСНАЯ миграция (KARMAN не гоняет drizzle-kit generate). Аддитивно:
-- ADD COLUMN с DEFAULT false — не деструктив, существующие токены остаются read-only.
-- Применяется на проде через psql ДО деплоя (см. docs/secrets-manager.md).

BEGIN;

ALTER TABLE secrets_token
  ADD COLUMN IF NOT EXISTS can_write boolean NOT NULL DEFAULT false;

COMMIT;
