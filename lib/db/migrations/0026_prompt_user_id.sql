-- 0026_prompt_user_id — библиотека промтов становится ЛИЧНОЙ (заказ владельца 2026-11-06).
--
-- «Информация у каждого аккаунта видна только ему; разделы и кнопки видны всем;
-- исключение — Круг, там кому выдано разрешение, тот видит.» Промт, надиктованный
-- владельцем, — его личная информация (он уходит в буфер и в нейронку), поэтому
-- таблица получает user_id и фильтруется тем же ownership(), что документы:
-- БЕЗ исключения для суперпользователя (см. lib/auth/rbac.ts).
--
-- Бэкфилл: до этого момента библиотека была одна (писал только владелец через
-- машинный канал), поэтому все строки переходят к ЖИВОМУ аккаунту владельца —
-- активному суперпользователю с наименьшим id. Если такого нет — строки
-- удаляются: промт без хозяина не имеет смысла, а «показывать всем» — ровно то,
-- что владелец запретил.
--
-- РУКОПИСНАЯ миграция: применить на проде через psql ДО деплоя (migration-guard
-- в deploy-prod.yml остановит автодеплой → дальше деплой через workflow_dispatch).

BEGIN;

ALTER TABLE prompt ADD COLUMN IF NOT EXISTS user_id integer;

-- Живой аккаунт владельца: активный суперпользователь с наименьшим id.
UPDATE prompt
SET user_id = (
  SELECT id FROM auth_user WHERE is_superuser AND is_active ORDER BY id LIMIT 1
)
WHERE user_id IS NULL;

DELETE FROM prompt WHERE user_id IS NULL;

ALTER TABLE prompt ALTER COLUMN user_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prompt_user_id_fkey'
  ) THEN
    ALTER TABLE prompt
      ADD CONSTRAINT prompt_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Основная выборка: «мои промты по проекту» и «мой архив».
CREATE INDEX IF NOT EXISTS prompt_user_project_idx
  ON prompt (user_id, project, created_at DESC);

COMMIT;
