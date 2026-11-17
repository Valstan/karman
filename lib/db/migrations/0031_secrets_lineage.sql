-- 0031_secrets_lineage — родословная производных секретов (D-191).
--
-- РУКОПИСНАЯ миграция (KARMAN не гоняет drizzle-kit generate). Применяется на проде
-- через psql ДО деплоя: migration-guard в deploy-prod.yml останавливает деплой,
-- пока миграция не лежит в журнале schema_migrations.
--
-- ЗАЧЕМ. Производная — это копия чужого секрета в своей комнате. Пока копии не помнили
-- своего источника, смерть источника проходила для них молча: копия оставалась в
-- обороте с уже несуществующим источником, и «кого предупредить перед ротацией»
-- собрать было нечем.
--
-- ЧТО ХРАНИМ (на строке secrets_item — по одному набору на комнату):
--   - origin_project_id — комната-источник, где лежит оригинал;
--   - origin_key       — ключ оригинала в той комнате;
--   - derived_by       — комната, которая завела копию (кто вывел);
--   - derived_at       — когда вывели;
--   - orphaned_at      — когда источник УМЕР (запись удалили / комнату-источник
--                        удалили / ключ переименовали). Не NULL — источник мёртв,
--                        и копия помечена; само значение копии при этом НЕ стирается
--                        (её по-прежнему видно, но она помечена как осиротевшая);
--   - source_unavailable_at — когда источник стал НЕДОСТУПЕН (у комнаты-источника
--                        отозвали последний живой токен). Это НЕ смерть источника:
--                        комнату можно перевыпустить, поэтому флаг снимается, когда
--                        токен у комнаты снова есть, и `orphaned_at` не ставится.
--
-- ИНВАРИАНТЫ:
--   - обычный секрет (не производная) имеет все шесть полей NULL — это не производная;
--   - ПРИЗНАК ПРОИЗВОДНОЙ — заполненный `origin_key`. Именно он, а не
--     `origin_project_id`: ссылка на комнату-источник обнуляется каскадом при её
--     удалении (ON DELETE SET NULL), и производная с умершей комнатой-источником
--     обязана остаться производной — иначе её родословная пропала бы вместе с
--     комнатой, а «копия осиротела» перестала бы быть видна;
--   - `origin_project_id` и `origin_key` заполняются вместе, иначе родословной нет;
--   - ON DELETE SET NULL на ссылках: смерть комнаты-источника не должна стирать
--     ПОМЕТКУ «осиротела» — её ставит код удаления (lib/services/secrets.ts) в той же
--     операции и в том же аудите, что и сама смерть (G600: триггер БД правит строки
--     молча, а след там и нужен);
--   - индекс по (origin_project_id, origin_key): именно по этой паре ищутся дома
--     производной — комнаты, где живут копии, — когда источник умирает.
--
-- ОБРАТНАЯ СОВМЕСТИМОСТЬ. Существующие секреты — обычные, без origin: миграция
-- только добавляет пустые колонки, ничего не переписывает.

BEGIN;

ALTER TABLE secrets_item
  ADD COLUMN IF NOT EXISTS origin_project_id bigint REFERENCES secrets_project (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin_key varchar(200),
  ADD COLUMN IF NOT EXISTS derived_by bigint REFERENCES secrets_project (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS derived_at timestamptz,
  ADD COLUMN IF NOT EXISTS orphaned_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_unavailable_at timestamptz;

CREATE INDEX IF NOT EXISTS secrets_item_origin_idx
  ON secrets_item (origin_project_id, origin_key);

CREATE INDEX IF NOT EXISTS secrets_item_derived_idx
  ON secrets_item (derived_by);

COMMIT;
