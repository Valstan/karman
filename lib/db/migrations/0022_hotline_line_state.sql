-- 0022_hotline_line_state — состояние линии в Телефоне (мандат brain 05.10, D-113).
--
-- РУКОПИСНАЯ миграция (KARMAN не гоняет drizzle-kit generate). Применяется на
-- проде через psql ДО деплоя (migration-guard в deploy-prod.yml блокирует
-- авто-деплой → деплой через workflow_dispatch).
--
-- `line_state` — состояние линии, пишется СОБЫТИЕМ, а не выводится из тиков:
-- снятие трубки ставит 'on_line', отбой (и авто-отбой сторожа после двух
-- пропущенных тиков) — 'offline'. Обычный тик без поля состояние не трогает.
-- Значения ASCII намеренно: метки и состояния ходят через bash-клиенты и
-- PowerShell-пробы, где не-ASCII уже портил байты (handoff 05.10, CRLF-находка).
-- Канон пары «на проводе»/«оффлайн» — в docs/hotline-relay.md, здесь только код.

BEGIN;

ALTER TABLE hotline_presence
  ADD COLUMN IF NOT EXISTS line_state varchar(16) NOT NULL DEFAULT 'offline';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hotline_presence_line_state_chk'
  ) THEN
    ALTER TABLE hotline_presence
      ADD CONSTRAINT hotline_presence_line_state_chk
      CHECK (line_state IN ('offline', 'on_line'));
  END IF;
END
$$;

COMMENT ON COLUMN hotline_presence.line_state IS
  'Состояние линии: offline (трубка положена) / on_line (на проводе). Пишется событием через POST presence, авто-отбой — sweep сторожа.';

COMMIT;
