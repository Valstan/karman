# Напоминания → Telegram — runbook

Система напоминаний с доставкой в Telegram (план — `docs/`-обсуждение, фазы P0–P5).
Этот документ — операционная часть: переменные окружения, миграция, воркер.

## Архитектура (P0)

- **Исходящее** — `lib/telegram/client.ts` (Bot API из Next-роутов).
- **Входящее** — тонкий воркер `scripts/reminders-worker.mjs` (long-poll `getUpdates`)
  реле в `POST /api/telegram/ingest` (Bearer). Никаких webhook/TLS — только egress.
- **Диспетчер** — `POST /api/reminders/dispatch` (Bearer), дёргается тем же воркером по
  таймеру (~25с). В P0 — скелет; логика due-scan/отправки — с P1.
- **Воркер-сервис** — `karman-reminders.service` (`Restart=always`), запускает
  `reminders-worker.mjs` из `current/`. Файл едет в артефакт при сборке
  (`deploy-prod.yml`, шаг Assemble).
- Эндпоинты `/api/*` не закрыты `proxy.ts` → защищаются сами `REMINDERS_INTERNAL_SECRET`.

## Переменные окружения (прод: `/etc/karman.env`)

Добавить к существующим (`SESSION_SECRET`, `DATABASE_URL`):

```
TELEGRAM_BOT_TOKEN=<токен от @BotFather>
TELEGRAM_BOT_USERNAME=<имя_бота_без_@>
REMINDERS_INTERNAL_SECRET=<openssl rand -base64 48>
```

Веб-приложение НЕ падает без них (ядро самодостаточно) — фича напоминаний просто
выключена: эндпоинты вернут 401, воркер простаивает с логом.

## Применить миграцию (вручную, ДО деплоя)

Миграция аддитивна (5 новых таблиц, без ALTER). Применяется владельцем на проде
**до** деплоя; migration-guard заблокирует авто-деплой push'ем → деплой через
`workflow_dispatch`.

```bash
# на проде, под пользователем с доступом к karman_db:
psql "$DATABASE_URL" -f lib/db/migrations/0001_telegram_reminders.sql
# проверить:
psql "$DATABASE_URL" -c '\dt' | grep -E 'reminder|telegram_link'
```

`drizzle-kit generate` НЕ запускать (миграций не было вовсе — он сгенерил бы baseline
всех Django-таблиц). Схему для типов держим в `lib/db/schema.ts` вручную.

## Установить воркер-сервис (один раз)

```bash
sudo cp scripts/karman-reminders.service /etc/systemd/system/karman-reminders.service
sudo systemctl daemon-reload && sudo systemctl enable --now karman-reminders
sudo systemctl status karman-reminders --no-pager
journalctl -u karman-reminders -n 50 --no-pager
```

## Деплой P0 (порядок)

1. Смержить PR (CI-гейты зелёные). Push в main запустит `deploy-prod.yml`, но
   migration-guard **завалит** его (в коммите новый `*.sql`) — это ожидаемо.
2. Применить миграцию на проде (psql, см. выше).
3. Прописать env-переменные в `/etc/karman.env`.
4. Запустить деплой: `gh workflow run deploy-prod.yml` (или `bash scripts/deploy_remote.sh`)
   — guard при `workflow_dispatch` пропускается.
5. Установить/перезапустить воркер-сервис (см. выше).

## Привязка чата (проверка)

1. В приложении: «Настройки» → «Сгенерировать ссылку» → открыть `t.me/<bot>?start=<code>`.
2. Нажать Start → бот отвечает «✅ Telegram привязан».
3. Проверка секрета: `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/api/reminders/dispatch`
   → 401; с `-H "Authorization: Bearer $REMINDERS_INTERNAL_SECRET"` → 200.

## Бот

- Использовать только в личке (DM). В группы не добавлять.
- Один поллер на бота: при 409 (конфликт) воркер ждёт — не запускать второй getUpdates
  и не ставить webhook параллельно.
