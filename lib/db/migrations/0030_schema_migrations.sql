-- 0030_schema_migrations — журнал применённых миграций (R1, гвард миграций).
--
-- ЗАЧЕМ. Прежний «Migration guard» в deploy-prod.yml отвечал на вопрос «принёс ли
-- ЭТОТ коммит миграцию», а защищать должен инвариант «код не уезжает на прод
-- раньше схемы». Окно было ровно между «миграция смержена» и «миграция применена»:
-- любой следующий code-коммит guard проходил и катил прод на неприменённую схему.
-- Дыра поймана и описана мозгу 28.07 (mailbox/to-brain/2026-07-28-migration-guard-
-- window-gotcha.md); закрывается здесь.
--
-- Теперь состояние живёт в БД: эта таблица — журнал применённых миграций, а шаг
-- деплоя спрашивает ПРОД, а не git («все файлы lib/db/migrations/*.sql есть в
-- журнале, иначе стоп»). Защита держится, пока схема реально не применена, и
-- снимается сама — ручного обхода через workflow_dispatch больше нет.
--
-- КТО ПИШЕТ В ЖУРНАЛ. Один путь: воркфлоу apply-migration.yml применяет файл и
-- сразу записывает его в журнал (scripts/migration_journal.sh record). Больше
-- никто журнал не пишет: ручная правка таблицы ломает сверку, и гвард это
-- покажет (запись есть — а схема может быть не той; записи нет — стоп).
--
-- BASELINE. Миграции 0001–0029 применялись ДО появления журнала, и отметок о
-- них не осталось. Они внесены списком с признаком baseline = true: это
-- УТВЕРЖДЕНИЕ о прошлом, а не наблюдение. Список заморожен — файл с номером
-- меньше 0030, появившийся позже, означает ошибку нумерации, и гейт
-- lib/db/migration-journal.test.ts её поймает.
--
-- ИНВАРИАНТЫ:
--   - version — четыре цифры, первичный ключ: журнал упорядочен, дубль невозможен;
--   - name — имя файла миграции, UNIQUE: переименование файла после применения
--     ломает сверку (гвард увидит «нет такой в журнале» и остановит деплой) —
--     а это ровно тот случай, который должен быть виден, а не тихо разъехаться;
--   - baseline = true только у строк, внесённых этим файлом; всё, что применено
--     после, пишет apply-migration.yml с baseline = false;
--   - applied_at у baseline-строк — время появления журнала, а не время
--     применения миграции (оно неизвестно и не восстановимо).

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  baseline   boolean NOT NULL DEFAULT false,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, name, baseline) VALUES
  ('0001', '0001_telegram_reminders.sql', true),
  ('0002', '0002_secrets_manager.sql', true),
  ('0003', '0003_secrets_token_write.sql', true),
  ('0004', '0004_secrets_cards.sql', true),
  ('0005', '0005_totp_2fa.sql', true),
  ('0006', '0006_secrets_grant.sql', true),
  ('0007', '0007_ecosystem_passport.sql', true),
  ('0008', '0008_secrets_bootstrap.sql', true),
  ('0009', '0009_esa_oidc_login.sql', true),
  ('0010', '0010_person_profile.sql', true),
  ('0011', '0011_document_fields_and_files.sql', true),
  ('0012', '0012_circle.sql', true),
  ('0013', '0013_circle_removed_at.sql', true),
  ('0014', '0014_secrets_grant_accepted.sql', true),
  ('0015', '0015_documents_hub.sql', true),
  ('0016', '0016_esa_identity_link.sql', true),
  ('0017', '0017_document_holder.sql', true),
  ('0018', '0018_family_tree.sql', true),
  ('0019', '0019_session_epoch.sql', true),
  ('0020', '0020_recovery_codes_kdf.sql', true),
  ('0021', '0021_hotline_relay.sql', true),
  ('0022', '0022_hotline_line_state.sql', true),
  ('0023', '0023_grant_policy.sql', true),
  ('0024', '0024_accounts.sql', true),
  ('0025', '0025_prompts.sql', true),
  ('0026', '0026_prompt_user_id.sql', true),
  ('0028', '0028_prompt_project.sql', true),
  ('0029', '0029_accounts_activation_index.sql', true)
ON CONFLICT (version) DO NOTHING;

COMMIT;
