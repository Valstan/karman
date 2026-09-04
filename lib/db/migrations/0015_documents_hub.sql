-- 0015_documents_hub — один раздел «Документы» (задача владельца 2026-09-04).
--
-- РУКОПИСНАЯ миграция (KARMAN не гоняет drizzle-kit generate). Применяется на
-- проде через psql ДО деплоя (migration-guard в deploy-prod.yml блокирует
-- авто-деплой → деплой через workflow_dispatch).
--
-- Две вещи.
--
-- 1. Явная выдача документа в круг. До сих пор участники круга видели ВСЕ
--    документы друг друга — согласие давалось на человека, а не на документ.
--    Владелец 04.09 попросил обратного: в круг попадает только то, что человек
--    сам отметил галочкой «В круг». Колонка `circle_shared_at`: NULL — только
--    мой; дата — открыт кругу. Существующие документы становятся ЛИЧНЫМИ:
--    выдача должна быть решением, а не наследством прежнего поведения.
--
-- 2. Реквизиты из «Моих данных» переезжают в документы. Раздел «Мои данные»
--    держал СНИЛС, ИНН, адреса, работу и контакты рядом с ФИО, а раздел
--    «Документы» предлагал шаблоны «СНИЛС» и «ИНН» — одно и то же в двух местах.
--    Карточка человека сжимается до того, что не документ: ФИО, дата и место
--    рождения, заметки. Остальное переносится в документы ниже — только там,
--    где значение непустое и такого документа у человека ещё нет. Колонки в
--    `person_profile` НЕ удаляются (`drop column` на живой схеме необратим),
--    код их больше не читает и не пишет.

BEGIN;

ALTER TABLE documents_document ADD COLUMN IF NOT EXISTS circle_shared_at timestamptz;
COMMENT ON COLUMN documents_document.circle_shared_at IS
  'Открыт кругу (явная галочка «В круг»). NULL — виден только владельцу.';
CREATE INDEX IF NOT EXISTS documents_document_circle_shared_idx
  ON documents_document (user_id) WHERE circle_shared_at IS NOT NULL;

-- Перенос реквизитов карточки в документы. Категория ищется по имени, запасная —
-- «Прочее»; документ создаётся один на группу, поля — строками document_field.
DO $$
DECLARE
  p RECORD;
  cat_other bigint := (SELECT id FROM documents_documentcategory WHERE name = 'Прочее' ORDER BY id LIMIT 1);
  cat_snils bigint := COALESCE((SELECT id FROM documents_documentcategory WHERE name = 'СНИЛС' ORDER BY id LIMIT 1),
                               (SELECT id FROM documents_documentcategory WHERE name = 'Прочее' ORDER BY id LIMIT 1));
  cat_inn   bigint := COALESCE((SELECT id FROM documents_documentcategory WHERE name = 'ИНН' ORDER BY id LIMIT 1),
                               (SELECT id FROM documents_documentcategory WHERE name = 'Прочее' ORDER BY id LIMIT 1));
  doc_id bigint;
BEGIN
  IF cat_other IS NULL THEN
    RAISE EXCEPTION 'Нет категории «Прочее» — перенос реквизитов невозможен';
  END IF;

  FOR p IN SELECT * FROM person_profile LOOP
    -- СНИЛС: номер — в ядро документа.
    IF btrim(p.snils) <> '' AND NOT EXISTS (
      SELECT 1 FROM documents_document d WHERE d.user_id = p.user_id AND d.document_type = 'СНИЛС'
    ) THEN
      INSERT INTO documents_document (title, document_type, document_number, issuing_authority, description, is_active, user_id, category_id)
      VALUES ('СНИЛС', 'СНИЛС', btrim(p.snils), '', '', TRUE, p.user_id, cat_snils);
    END IF;

    -- ИНН.
    IF btrim(p.inn) <> '' AND NOT EXISTS (
      SELECT 1 FROM documents_document d WHERE d.user_id = p.user_id AND d.document_type = 'ИНН'
    ) THEN
      INSERT INTO documents_document (title, document_type, document_number, issuing_authority, description, is_active, user_id, category_id)
      VALUES ('ИНН', 'ИНН', btrim(p.inn), '', '', TRUE, p.user_id, cat_inn);
    END IF;

    -- Адреса: прописка и фактический — полями одного документа.
    IF (btrim(p.registration_address) <> '' OR btrim(p.actual_address) <> '') AND NOT EXISTS (
      SELECT 1 FROM documents_document d WHERE d.user_id = p.user_id AND d.document_type = 'Адреса'
    ) THEN
      INSERT INTO documents_document (title, document_type, document_number, issuing_authority, description, is_active, user_id, category_id)
      VALUES ('Адреса', 'Адреса', '', '', '', TRUE, p.user_id, cat_other)
      RETURNING id INTO doc_id;
      INSERT INTO document_field (document_id, name, value, position)
      SELECT doc_id, f.name, f.value, f.pos
      FROM (VALUES ('Прописка', btrim(p.registration_address), 0),
                   ('Фактический адрес', btrim(p.actual_address), 1)) AS f(name, value, pos)
      WHERE f.value <> '';
    END IF;

    -- Работа.
    IF (btrim(p.employer) <> '' OR btrim(p.job_title) <> '') AND NOT EXISTS (
      SELECT 1 FROM documents_document d WHERE d.user_id = p.user_id AND d.document_type = 'Работа'
    ) THEN
      INSERT INTO documents_document (title, document_type, document_number, issuing_authority, description, is_active, user_id, category_id)
      VALUES ('Работа', 'Работа', '', '', '', TRUE, p.user_id, cat_other)
      RETURNING id INTO doc_id;
      INSERT INTO document_field (document_id, name, value, position)
      SELECT doc_id, f.name, f.value, f.pos
      FROM (VALUES ('Место работы', btrim(p.employer), 0),
                   ('Должность', btrim(p.job_title), 1)) AS f(name, value, pos)
      WHERE f.value <> '';
    END IF;

    -- Контакты: телефон и почта.
    IF (btrim(p.phone) <> '' OR btrim(p.email) <> '') AND NOT EXISTS (
      SELECT 1 FROM documents_document d WHERE d.user_id = p.user_id AND d.document_type = 'Контакты'
    ) THEN
      INSERT INTO documents_document (title, document_type, document_number, issuing_authority, description, is_active, user_id, category_id)
      VALUES ('Контакты', 'Контакты', '', '', '', TRUE, p.user_id, cat_other)
      RETURNING id INTO doc_id;
      INSERT INTO document_field (document_id, name, value, position)
      SELECT doc_id, f.name, f.value, f.pos
      FROM (VALUES ('Телефон', btrim(p.phone), 0),
                   ('Электронная почта', btrim(p.email), 1)) AS f(name, value, pos)
      WHERE f.value <> '';
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN person_profile.snils IS 'РУДИМЕНТ с 0015: перенесено в документ «СНИЛС», код не читает.';
COMMENT ON COLUMN person_profile.inn IS 'РУДИМЕНТ с 0015: перенесено в документ «ИНН», код не читает.';
COMMENT ON COLUMN person_profile.registration_address IS 'РУДИМЕНТ с 0015: перенесено в документ «Адреса».';
COMMENT ON COLUMN person_profile.actual_address IS 'РУДИМЕНТ с 0015: перенесено в документ «Адреса».';
COMMENT ON COLUMN person_profile.employer IS 'РУДИМЕНТ с 0015: перенесено в документ «Работа».';
COMMENT ON COLUMN person_profile.job_title IS 'РУДИМЕНТ с 0015: перенесено в документ «Работа».';
COMMENT ON COLUMN person_profile.phone IS 'РУДИМЕНТ с 0015: перенесено в документ «Контакты».';
COMMENT ON COLUMN person_profile.email IS 'РУДИМЕНТ с 0015: перенесено в документ «Контакты».';

COMMIT;
