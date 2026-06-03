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

## Сверка схемы с боевой БД (обязательно перед первым прод-деплоем)

`lib/db/schema.ts` написана по фактическим колонкам из старого API. Перед продом сверить с реальной БД:

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
sudo cp scripts/karman.service /etc/systemd/system/karman.service
sudo tee /etc/karman.env >/dev/null <<'EOF'
SESSION_SECRET=<openssl rand -base64 48>
DATABASE_URL=postgres:///karman_db?host=/var/run/postgresql
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now karman
sudo systemctl disable --now karman-api      # старый Express-сервис больше не нужен

# nginx: взять за основу scripts/nginx.karman.conf (единый proxy_pass на :3000,
# обязателен проброс X-Forwarded-Proto). Затем:
sudo nginx -t && sudo systemctl reload nginx
```

Регулярный деплой:

```bash
scripts/deploy.sh           # git pull → npm ci → build → (migrate) → restart → healthcheck
```

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
