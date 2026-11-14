-- 0032_account_tokens — токены аккаунтов MiniMax (OAuth device-flow), заказ владельца 14.11.
--
-- РУКОПИСНАЯ миграция (KARMAN не гоняет drizzle-kit generate). Применяется на проде
-- через psql ДО деплоя: migration-guard в deploy-prod.yml блокирует авто-деплой
-- для коммита с миграцией (лечение — журнал schema_migrations, см. тех-долг).
--
-- ЗАЧЕМ. Аккаунты MiniMax в базе уже есть (85 штук) и по ним ведётся статистика,
-- но ТОКЕНА агента (пара access/refresh от OAuth) у нас нет ни у одного: владелец
-- входил в аккаунты вручную в браузере, и рабочая копия профиля жила только на компе
-- и на боксе соседа. Сарафан (письмо на линии «Телефона», 14.11) описал рецепт:
-- у MiniMax только OAuth device-flow, refresh-токен ОДНОРАЗОВЫЙ (повторное
-- использование вендер считает злоупотреблением и отзывает цепочку). Значит токен
-- надо добыть ОДИН раз на аккаунт, хранить и отдавать проекту ровно один раз.
--
-- ДВА ОБЪЕКТА:
--   1) account_token_flow — незавершённый device-flow: device_code и code_verifier
--      (оба секреты — шифруются), плюс user_code (его вводит владелец, не секрет)
--      и срок жизни кода (~10 минут).
--   2) account_token — добытая пара, шифротекстом одним блоком (JSON), плюс
--      срок жизни access-токена и отметка «пара отдана проекту» (после отдачи
--      свой refresh мы НЕ крутим: цепочка одна).
--
-- ИНВАРИАНТЫ:
--   - на аккаунт — одна живая пара (account_token_account_uq);
--   - на аккаунт — один открытый device-flow (account_token_flow_open_uq): второй
--     «Следующий» по тому же аккаунту не заводим;
--   - пара не хранится в открытом виде: access/refresh лежат шифротекстом (ключ
--     мастер-ключа vault, AAD — id аккаунта).

BEGIN;

CREATE TABLE IF NOT EXISTS account_token_flow (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  account_id bigint NOT NULL REFERENCES accounts_account(id) ON DELETE CASCADE,
  -- device_code — секрет (шифротекст): им обмениваются на пару токенов.
  device_code text NOT NULL,
  device_code_iv text NOT NULL,
  device_code_tag text NOT NULL,
  -- code_verifier — секрет PKCE (шифротекст): доказывает, что обмен наш.
  code_verifier text NOT NULL,
  code_verifier_iv text NOT NULL,
  code_verifier_tag text NOT NULL,
  -- user_code — не секрет: его владелец вводит на странице MiniMax.
  user_code text NOT NULL,
  verification_uri text NOT NULL,
  -- Готовая ссылка с кодом внутри (вендер отдаёт её сам) — если есть, берём её.
  verification_uri_complete text,
  -- Когда код перестанет работать (живёт около 5 минут — вендер отдаёт expires_in).
  expires_at timestamptz NOT NULL,
  -- 'pending' — ждём подтверждения владельца; 'done' — пара получена;
  -- 'expired' — код не подтвердили в срок; 'failed' — вендер ответил ошибкой.
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'account_token_flow_state_range'
  ) THEN
    ALTER TABLE account_token_flow
      ADD CONSTRAINT account_token_flow_state_range
      CHECK (state IN ('pending', 'done', 'expired', 'failed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS account_token_flow_open_uq
  ON account_token_flow (account_id) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS account_token (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  account_id bigint NOT NULL REFERENCES accounts_account(id) ON DELETE CASCADE,
  -- Пара токенов одним JSON-блоком под шифротекстом: {access, refresh}.
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  -- Срок жизни access-токена (~3600 с у MiniMax).
  expires_at timestamptz NOT NULL,
  -- Пара отдана проекту: с этого момента СВОЙ refresh мы не крутим никогда.
  handed_over_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_token_account_uq
  ON account_token (account_id);

COMMIT;
