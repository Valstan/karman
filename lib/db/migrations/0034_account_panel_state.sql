-- 0034_account_panel_state — состояние суток аккаунта по панели MiniMax в БД.
--
-- РУКОПИСНАЯ миграция (KARMAN не гоняет drizzle-kit generate). Применяется на проде
-- через psql ДО деплоя: migration-guard в deploy-prod.yml останавливает деплой,
-- пока миграция не лежит в журнале schema_migrations.
--
-- ЗАЧЕМ. Панель MiniMax — единственный источник правды о том, есть ли у аккаунта
-- сегодняшние очки (заказ владельца 16.11: «сделать аккаунты активными, когда очки
-- появятся»). До сих пор состояние панели жило в памяти процесса (Map в
-- lib/services/minimax-daily.ts): оно не переживало рестарт, и — главное — action
-- и страница попадали в РАЗНЫЕ чанки Turbopack, то есть видели разное состояние.
--
-- Теперь состояние лежит в БД: его видят и выдача, и страница владельца, и
-- автосверка по таймеру. Читается панель только на чтение — очки не тратятся.
--
-- ЧТО ХРАНИМ (по паре «аккаунт + пояс» — одна строка):
--   - cell_no   — номер клетки в недельном круге (1..7), какой панель считает сегодняшним;
--   - status    — статус клетки панели: 1 — не начался, 2 — можно забрать,
--                  3 — забрано, 4 — недоступен;
--   - points    — сколько очков даст сегодняшняя клетка (400 или 1000);
--   - can_claim — «очки можно забрать прямо сейчас» (status = 2);
--   - checked_at— когда панель читали: по этому полю видно, что состояние протухло
--                  (свежее — полчаса), и тогда решает старая эвристика ночного сброса.
--
-- ПОЧЕМУ ПОЯЗ — ЧАСТЬ КЛЮЧА. Сутки MiniMax считаются по поясу ЗАПРОСА (так написано
-- у вендора), поэтому у панели владельца (Europe/Moscow) и у панели проекта (UTC)
-- «сегодня» — разные дни в ночном окне между 00:00 и 03:00 МСК. Именно в это окно
-- 15.11 пятнадцать аккаунтов подряд отказали с «insufficient balance (1008)»: у
-- владельца сутки уже сменились, а у проекта — ещё нет. Смешивать эти два ответа
-- нельзя, поэтому состояние хранится по паре «аккаунт + пояс», а выдача берёт
-- ответ для пояса ПОТРЕБИТЕЛЯ.
--
-- ИНВАРИАНТЫ:
--   - одна строка на пару «аккаунт + пояс» (primary key по обоим полям): «очки
--     есть/очки сожжены» — свойство пары «аккаунт + его сутки»;
--   - строка НЕ удаляется, когда очки сожгли: её обновляет следующая сверка, а до
--     неё протухшее состояние честно значит «не знаю» (см. checked_at);
--   - удаляется строка только вместе с аккаунтом (ON DELETE CASCADE).

BEGIN;

CREATE TABLE IF NOT EXISTS account_panel_state (
  account_id bigint NOT NULL REFERENCES accounts_account (id) ON DELETE CASCADE,
  timezone_id varchar(64) NOT NULL DEFAULT 'UTC',
  user_id integer NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  cell_no smallint NOT NULL DEFAULT 0,
  status smallint NOT NULL DEFAULT 0,
  points integer NOT NULL DEFAULT 0,
  can_claim boolean NOT NULL DEFAULT false,
  checked_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_panel_state_pkey PRIMARY KEY (account_id, timezone_id)
);

CREATE INDEX IF NOT EXISTS account_panel_state_user_idx
  ON account_panel_state (user_id, timezone_id);

COMMIT;
