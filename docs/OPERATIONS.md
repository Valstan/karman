# Operations

## Работа с проектом локально

- Frontend:

  ```bash
  cd /home/valstan/karman/frontend
  npm install
  npm run dev
  ```

- API:

  ```bash
  cd /home/valstan/karman/api
  npm install
  npm run dev
  ```

- Production build:

  ```bash
  cd /home/valstan/karman/frontend
  npm run build
  ```

## Рекомендуемый деплой

- Сборка SPA:

  ```bash
  /home/valstan/karman/scripts/build_spa.sh
  ```

- Деплой SPA:

  ```bash
  /home/valstan/karman/scripts/deploy_spa.sh
  ```

- Деплой и перезапуск API:

  ```bash
  /home/valstan/karman/scripts/deploy_api.sh
  /home/valstan/karman/scripts/restart_api.sh
  ```

- Проверки сервисов:

  ```bash
  sudo systemctl status karman-api --no-pager
  sudo systemctl status nginx --no-pager
  ```

- Переменные Cursor-монитора (фоновый сбор):

  ```bash
  sudo nano /etc/systemd/system/karman-api.env
  ```

  Значения по умолчанию, которые уже есть в `/etc/systemd/system/karman-api.env`:

  - `CURSOR_MODEL_COLLECTION_INTERVAL_MS=18000000`
  - `CURSOR_MODEL_REPORT_INTERVAL_MS=86400000`
  - `CURSOR_MODEL_RETENTION_DAYS=7`
  - `CURSOR_MODEL_REPORT_HOUR_UTC=9`
  - `CURSOR_MODEL_MONITOR_ENABLED=true`
  - `CURSOR_MODEL_TELEGRAM_BOT_TOKEN=<токен>`
  - `CURSOR_MODEL_TELEGRAM_CHAT_ID=<chat_id>`

  После изменения переменных:

  ```bash
  sudo systemctl restart karman-api
  ```

## Nginx и SSL

- Проверить конфиг:

  ```bash
  sudo nginx -t
  ```

- Применить изменения:

  ```bash
  sudo systemctl reload nginx
  ```

- Проверить сертификат/renew:

  ```bash
  /home/valstan/karman/scripts/check_ssl_renewal.sh
  ```

  При ручном продлении:

  ```bash
  sudo certbot renew --cert-name 4ce93c2b59f9.vps.myjino.ru --nginx --non-interactive
  sudo systemctl reload nginx
  ```

## Проверки работоспособности

- Базовая доступность:

  ```bash
  curl -IL https://4ce93c2b59f9.vps.myjino.ru/
  curl -IL https://4ce93c2b59f9.vps.myjino.ru/dashboard
  ```

- API health и данные:

  ```bash
  curl -sS https://4ce93c2b59f9.vps.myjino.ru/api/health
  curl -sS https://4ce93c2b59f9.vps.myjino.ru/api/v1/dashboard/summary/
  ```

- Проверка входа (замените учётные данные):

  ```bash
  curl -i -X POST "https://4ce93c2b59f9.vps.myjino.ru/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    --data '{"username":"admin","password":"admin123"}'
  ```

## Памятка по привилегиям

- Проверка режима `sudo` выполнена как `sudo -n true` — на текущем окружении пароль не требуется.
- Зафиксируй это в рабочей памяти сессии: изменения, требующие `sudo`, можно выполнять без ввода пароля.

## Сессии разработки с нейросетью

- Продолжение ведения проекта между сессиями описано в `docs/AI_SESSION_CONTINUITY.md`.
