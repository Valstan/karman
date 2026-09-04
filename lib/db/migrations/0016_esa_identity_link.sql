-- Привязка личности ЕСА к аккаунту из интерфейса (задача владельца 2026-09-04)
-- и отвязка, которой до сих пор не было вовсе.
--
-- Отвязка сделана ПОМЕТКОЙ, а не DELETE: строка — единственный след того, что
-- связь существовала, а у auth_audit нет колонки detail, то есть после
-- физического удаления не восстановить, какую именно связь убрали.
--
-- Уникальность в 0009 объявлена ОГРАНИЧЕНИЕМ таблицы, а не голым индексом,
-- поэтому здесь DROP CONSTRAINT, а не DROP INDEX: копия рецепта из 0014
-- (где индекс был голым) на этой таблице просто не применилась бы.
BEGIN;

ALTER TABLE auth_oidc_identity
  DROP CONSTRAINT IF EXISTS auth_oidc_identity_issuer_subject_key;

ALTER TABLE auth_oidc_identity
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- Одна ЖИВАЯ личность на пару (issuer, subject): отозванная не мешает завести
-- связь заново, в этом смысл частичности. Гонка двух одновременных привязок
-- ловится нарушением этого индекса, а не предварительной выборкой.
CREATE UNIQUE INDEX IF NOT EXISTS auth_oidc_identity_issuer_subject_live_uq
  ON auth_oidc_identity (issuer, subject)
  WHERE revoked_at IS NULL;

-- Одна ЖИВАЯ личность у пользователя на одного издателя. В 0009 допускалось
-- несколько («рабочая/личная»), но с приходом кнопки это стало вредным: без
-- отвязки лишние связи было бы нечем убрать, а какая из них «та» — непонятно.
-- Инвариант держится индексом, а не проверкой в коде: проверка гонку не ловит.
CREATE UNIQUE INDEX IF NOT EXISTS auth_oidc_identity_issuer_user_live_uq
  ON auth_oidc_identity (issuer, user_id)
  WHERE revoked_at IS NULL;

COMMIT;
