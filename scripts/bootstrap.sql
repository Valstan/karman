-- Локальная схема + сид для разработки на Windows (docker-compose).
-- Зеркалит lib/db/schema.ts. На боевой БД НЕ выполняется (там схема от Django).
-- Применяется автоматически при первом старте контейнера postgres.

-- ---------------------------------------------------------------------------
-- Схема
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_user (
  id           SERIAL PRIMARY KEY,
  password     VARCHAR(128) NOT NULL,
  last_login   TIMESTAMPTZ,
  is_superuser BOOLEAN NOT NULL DEFAULT FALSE,
  username     VARCHAR(150) NOT NULL UNIQUE,
  first_name   VARCHAR(150) NOT NULL DEFAULT '',
  last_name    VARCHAR(150) NOT NULL DEFAULT '',
  email        VARCHAR(254) NOT NULL DEFAULT '',
  is_staff     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  date_joined  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credits_bank (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  address    VARCHAR(500),
  phone      VARCHAR(50),
  email      VARCHAR(254),
  website    VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credits_credit (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL DEFAULT '',
  description     VARCHAR(2000),
  amount          NUMERIC(14, 2) NOT NULL,
  interest_rate   NUMERIC(6, 2) NOT NULL,
  monthly_payment NUMERIC(14, 2),
  payment_type    VARCHAR(20) NOT NULL DEFAULT 'annuity',
  start_date      DATE NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  term_months     INTEGER NOT NULL,
  bank_id         INTEGER NOT NULL REFERENCES credits_bank(id),
  user_id         INTEGER NOT NULL REFERENCES auth_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credits_payment (
  id               SERIAL PRIMARY KEY,
  credit_id        INTEGER NOT NULL REFERENCES credits_credit(id) ON DELETE CASCADE,
  amount           NUMERIC(14, 2) NOT NULL,
  principal_amount NUMERIC(14, 2),
  interest_amount  NUMERIC(14, 2),
  due_date         DATE NOT NULL,
  paid_date        DATE,
  status           VARCHAR(20) NOT NULL DEFAULT 'scheduled',
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents_documentcategory (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(2000) NOT NULL DEFAULT '',
  icon        VARCHAR(50) NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents_document (
  id                SERIAL PRIMARY KEY,
  title             VARCHAR(255) NOT NULL,
  description       VARCHAR(2000) NOT NULL DEFAULT '',
  document_type     VARCHAR(50) NOT NULL DEFAULT '',
  document_number   VARCHAR(100) NOT NULL DEFAULT '',
  issue_date        DATE,
  expiry_date       DATE,
  issuing_authority VARCHAR(255),
  front_image       VARCHAR(100),
  back_image        VARCHAR(100),
  additional_files  VARCHAR(100),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  user_id           INTEGER NOT NULL REFERENCES auth_user(id),
  category_id       INTEGER NOT NULL REFERENCES documents_documentcategory(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Сид
-- ---------------------------------------------------------------------------
-- admin / admin123  (хеш pbkdf2_sha256, совместим с verifyDjangoPassword)
INSERT INTO auth_user (password, is_superuser, username, first_name, is_staff, is_active)
VALUES (
  'pbkdf2_sha256$260000$devsalt12345678$+STEz7mNAe0s1dphwRqFsJQf0f65Du5cTtlcjk0Yj+I=',
  TRUE, 'admin', 'Администратор', TRUE, TRUE
);

INSERT INTO credits_bank (name, website, phone) VALUES
  ('Сбербанк', 'https://sberbank.ru', '900'),
  ('Т-Банк', 'https://tbank.ru', '8800'),
  ('ВТБ', 'https://vtb.ru', '1000');

-- Кредит 1: аннуитет, частично погашен
INSERT INTO credits_credit (name, amount, interest_rate, monthly_payment, payment_type, start_date, status, term_months, bank_id, user_id)
VALUES ('Потребительский', 300000, 18.50, 10800, 'annuity', '2025-09-05', 'active', 36, 1, 1);

INSERT INTO credits_payment (credit_id, amount, principal_amount, interest_amount, due_date, paid_date, status) VALUES
  (1, 10800, 6175, 4625, '2025-10-05', '2025-10-04', 'paid'),
  (1, 10800, 6270, 4530, '2025-11-05', '2025-11-05', 'paid'),
  (1, 10800, 6367, 4433, '2025-12-05', NULL, 'overdue'),
  (1, 10800, 6465, 4335, '2026-06-05', NULL, 'scheduled'),
  (1, 10800, 6565, 4235, '2026-07-05', NULL, 'scheduled');

-- Кредит 2: дифференцированный, новый
INSERT INTO credits_credit (name, amount, interest_rate, monthly_payment, payment_type, start_date, status, term_months, bank_id, user_id)
VALUES ('Авто', 600000, 14.00, NULL, 'differentiated', '2026-05-10', 'active', 24, 3, 1);

INSERT INTO credits_payment (credit_id, amount, principal_amount, interest_amount, due_date, paid_date, status) VALUES
  (2, 32000, 25000, 7000, '2026-06-10', NULL, 'scheduled'),
  (2, 31700, 25000, 6700, '2026-07-10', NULL, 'scheduled'),
  (2, 31400, 25000, 6400, '2026-08-10', NULL, 'scheduled');

-- Категории документов (id=8 «Прочее» — запасная категория, как в боевой БД).
INSERT INTO documents_documentcategory (id, name) VALUES
  (1, 'Паспорт'),
  (2, 'Водительские права'),
  (3, 'СНИЛС'),
  (4, 'ИНН'),
  (5, 'Полис ОМС'),
  (6, 'Загранпаспорт'),
  (7, 'Свидетельство'),
  (8, 'Прочее');
-- SERIAL не двигается при явных id — подвинем последовательность, чтобы будущие вставки не конфликтовали.
SELECT setval('documents_documentcategory_id_seq', (SELECT MAX(id) FROM documents_documentcategory));

INSERT INTO documents_document (title, document_type, document_number, issue_date, expiry_date, issuing_authority, is_active, user_id, category_id)
VALUES
  ('Паспорт РФ', 'passport', '1234 567890', '2015-03-12', NULL, 'ОУФМС', TRUE, 1, 1),
  ('Водительское удостоверение', 'license', '99 ББ 123456', '2020-07-01', '2030-07-01', 'ГИБДД', TRUE, 1, 2);
