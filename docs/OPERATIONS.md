# Эксплуатация KARMAN

## Локальная разработка (Windows / без боевой БД)

```bash
cp .env.example .env.local
docker compose up -d        # PostgreSQL + схема + сид из scripts/bootstrap.sql
npm install
npm run dev                 # http://localhost:3000  (вход: admin / admin123)
```

Сброс локальной БД: `docker compose down -v && docker compose up -d`.

## Проверки перед деплоем

```bash
npm run build       # сборка + типы
npm run test        # юнит-тесты (график платежей, пароли, деньги)
```

## Сверка схемы с боевой БД

> **Выполнено 2026-06-04** (`pg_dump --schema-only` боевой `karman_db`). `lib/db/schema.ts`
> приведена в соответствие: bigint-identity PK/FK, NOT NULL без дефолтов (`.$defaultFn`),
> добавлены `credits_payment.created_at`, `documents_document.{description,category_id,…}`,
> точности `numeric(12,2)`/`(5,2)`. Проверено транзакцией с ROLLBACK против боевой БД.

Повторная сверка (если схема БД менялась):

```bash
# на машине с доступом к КЛОНУ/ДАМПУ боевой БД:
DATABASE_URL=postgres://... npm run db:pull       # генерирует схему из реальной БД
# сравнить с lib/db/schema.ts и привести в соответствие при расхождениях
```

## База данных и миграции

- Боевая БД создана исторически (Django). Таблицы уже существуют — **baseline-миграцию нельзя
  выполнять как DDL** на проде.
- Порядок при первом внедрении миграций:
  1. `npm run db:generate` — сгенерировать baseline `0000` из схемы.
  2. На проде пометить `0000` применённой **без выполнения DDL**: вставить её запись в служебную
     таблицу `drizzle.__drizzle_migrations` (hash из `lib/db/migrations/meta/_journal.json`).
     Предварительно проверить весь поток на клоне БД.
  3. Все последующие изменения — только в `0001+`, они и применяются `npm run db:migrate`.

## Деплой (сервер, единый процесс Next.js)

Первичная настройка:

```bash
# Роль приложения (peer-auth для valstan на боевом сервере НЕ работает — нужен
# отдельный логин-роль с паролем; см. историю деплоя 2026-06-04):
sudo -u postgres psql -d karman_db <<'SQL'
CREATE ROLE karman_app LOGIN PASSWORD '<openssl rand -hex 24>';
GRANT CONNECT ON DATABASE karman_db TO karman_app;
GRANT USAGE ON SCHEMA public TO karman_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO karman_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO karman_app;
SQL

sudo cp scripts/karman.service /etc/systemd/system/karman.service
sudo tee /etc/karman.env >/dev/null <<'EOF'
SESSION_SECRET=<openssl rand -base64 48>
DATABASE_URL=postgres://karman_app:<пароль роли>@/karman_db?host=/var/run/postgresql
EOF
sudo chmod 600 /etc/karman.env
sudo systemctl daemon-reload && sudo systemctl enable --now karman
sudo systemctl disable --now karman-api      # старый Express-сервис больше не нужен

# nginx: взять за основу scripts/nginx.karman.conf (единый proxy_pass на :3000,
# обязателен проброс X-Forwarded-Proto). Затем:
sudo nginx -t && sudo systemctl reload nginx
```

Регулярный деплой — **CI-artifact** (`.github/workflows/deploy-prod.yml`): push в main
собирает standalone-бандл в GitHub Actions, по SSH кладёт его в
`/home/valstan/karman/releases/<sha>`, переключает симлинк `current`, рестартит сервис и
гонит smoke. On-box `next build` запрещён (мандат brain 2026-06-11 — на общем боксе мешает
соседям). Ручной повторный запуск: `bash scripts/deploy_remote.sh` (gh workflow run + watch).

Миграции standalone-бандл не несёт: новые `lib/db/migrations/*.sql` применяются вручную
ДО деплоя (push с новой миграцией CI-guard роняет; после ручного применения — деплой через
`workflow_dispatch`). Смена deploy-target (миграция на Бокс 1) = правка repo-vars
`DEPLOY_SSH_HOST` / `DEPLOY_SSH_PORT` / `DEPLOY_APP_PORT` + secret `SSH_PRIVATE_KEY`.

## Медиа-каталог (сканы документов)

- Пользовательские сканы хранятся на ФС в `MEDIA_ROOT` (env в systemd-юните;
  `/home/valstan/karman/media` — вне релиз-директорий, переживает деплои).
  должен быть writable для пользователя сервиса (`valstan`). В БД хранится только относительный
  путь вида `documents/<userId>/<docId>/<slot>-<token>.<ext>`.
- **Бэкап:** каталог `media/` не входит в git и не восстановится из репозитория — включить его
  в регулярный бэкап вместе с дампом БД, иначе ссылки в БД будут указывать на отсутствующие файлы.
- Отдаются файлы только через авторизованный route `/api/documents/[id]/file/[slot]`
  (проверка владельца), напрямую через nginx — нет.

## Здоровье и логи

```bash
curl -sS http://127.0.0.1:3000/api/health      # {"status":"ok"}
sudo systemctl status karman --no-pager
sudo journalctl -u karman -f
```

## SSL

TLS — через certbot (как раньше). Проверка автопродления: `scripts/check_ssl_renewal.sh`.

## Примечания по миграции со старого стека

- Формат сессии изменён (JWT вместо самописного HMAC), cookie переименован в `karman_session_v2` —
  при первом заходе потребуется повторный вход.
- `SESSION_SECRET` обязателен в production: без него сервис намеренно не стартует.
