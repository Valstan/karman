# KARMAN

KARMAN is a React SPA served by nginx. Django, Celery, and related backend runtime artifacts are removed from this deployment.

## Current structure

- `api/` - lightweight Node.js API (Express + PostgreSQL)
- `frontend/` - React source code
- `frontend_dist/` - production build served by nginx
- `scripts/` - operational scripts for SPA/API deploy and SSL checks
- `docs/` - current operational and architecture docs

## Local development

```bash
cd /home/valstan/karman/frontend
npm install
npm run dev
```

## Production build

```bash
cd /home/valstan/karman/frontend
npm install
npm run build
```

## Runtime

- Web server: `nginx`
- API service: `karman-api.service` (Node.js, local port `8080`)
- Database: PostgreSQL (`karman_db`)
- Auth: API session cookie, users from `auth_user` table
- SPA routing: history fallback to `index.html`

## Login

- Login form now validates real users from database (`auth_user`).
- Session is stored in secure HttpOnly cookie (`karman_session`).
- Existing admin account works: `admin / admin123`.

## Cursor AI модель-мониторинг

Выполняет сбор данных по новым моделям Cursor:
- опрашивает `cursor.com/docs/models` и `cursor.com/changelog`
- опрашивает интернет-ленту и обзоры (RSS) каждые 5 часов
- формирует ежедневный сводный отчет и отправляет его в Telegram
- хранит отчеты и сырые события в PostgreSQL
- отдает отчеты в SPA по адресу `/cursor-model-reports`

### Переменные окружения

Добавьте в окружение API (systemd/env-файл/контейнер):

```bash
TELEGRAM_BOT_TOKEN=<ваш_бот_токен_или_используйте_CURSOR_MODEL_...>
TELEGRAM_CHAT_ID=<id_чата_для_уведомлений>
# или:
CURSOR_MODEL_TELEGRAM_BOT_TOKEN=<ваш_бот_токен>
CURSOR_MODEL_TELEGRAM_CHAT_ID=<id_чата>

CURSOR_MODEL_MONITOR_ENABLED=true
CURSOR_MODEL_COLLECTION_INTERVAL_MS=18000000
CURSOR_MODEL_REPORT_INTERVAL_MS=86400000
CURSOR_MODEL_RETENTION_DAYS=7
CURSOR_MODEL_REPORT_HOUR_UTC=9
```

Можете использовать шаблон как заготовку:

```bash
sudo cp /home/valstan/karman/api/.env.cursor-model-monitor.example /etc/systemd/system/karman-api.env
sudo systemctl restart karman-api
```

`CURSOR_MODEL_MONITOR_ENABLED=false` временно отключает автозапуск фона.

### Проверка после деплоя

1. Перезапустите API:

```bash
cd /home/valstan/karman
sudo systemctl restart karman-api
```

2. Проверьте healthcheck и создание таблиц/логов:

```bash
curl -sS http://127.0.0.1:8080/api/health
```

3. Откройте страницу отчетов:

```text
http://<ваш-домен>/cursor-model-reports
```

### API endpoint-ы (для админа)

- `GET /api/v1/cursor-model-reports/` — список отчетов
- `GET /api/v1/cursor-model-reports/<id>/` — детальный отчет
- `DELETE /api/v1/cursor-model-reports/<id>/` — удалить
- `POST /api/v1/cursor-model-reports/collect-now/` — срочно собрать новости
- `POST /api/v1/cursor-model-reports/run-now/` — срочно отправить дневной отчет в Telegram

## Main scripts

```bash
/home/valstan/karman/scripts/build_spa.sh
/home/valstan/karman/scripts/deploy_spa.sh
/home/valstan/karman/scripts/deploy_api.sh
/home/valstan/karman/scripts/restart_api.sh
/home/valstan/karman/scripts/check_ssl_renewal.sh
```
