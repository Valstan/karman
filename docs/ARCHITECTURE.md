# Project architecture (KARMAN)

## Ключевая идея

Проект — это монолитный SPA frontend + отдельный REST API на одном сервере:

- `frontend/` — исходники React SPA (TypeScript, Vite, Ant Design)
- `api/` — backend на Node.js (Express + PostgreSQL)
- `frontend_dist/` — собранный bundle для продакшена
- `nginx` — раздаёт SPA и проксирует API

## Runtime graph

1. Браузер клиента обращается к домену проекта.
2. `nginx`:
   - отдает статические файлы из `frontend_dist/`
   - для SPA-роутов делает fallback на `index.html`
   - все запросы по `/api/*` переадресует на `127.0.0.1:8080`
3. `api/server.js` обрабатывает `/api/v1/*` и работает с БД `karman_db`.

## Аутентификация и сессии

- Пользовательские учётки лежат в таблице `auth_user`.
- Вход: `POST /api/v1/auth/login`.
- При успешном входе формируется подписанный cookie-сессионный токен `karman_session` (HttpOnly).
- Проверка сессии: `GET /api/v1/auth/me`, `GET /api/v1/auth/check/`.
- Выход: `POST /api/v1/auth/logout`.

## Основные API-группы

- `dashboard`: `/api/v1/dashboard/summary/`
- `banks`: `/api/v1/credits/banks/`
- `credits`: `/api/v1/credits/credits/` (GET/POST/PATCH)
- `payments`: `/api/v1/credits/payments/` (GET/PATCH)
- `documents`: `/api/v1/documents/`
- `health`: `/api/health`

## Data model (ядро)

- `auth_user` — пользователи
- `credits_bank` — банки / МФО
- `credits_credit` — кредиты (основная карточка)
- `credits_payment` — платежи по кредитам
- `documents_document` — документы пользователя

## Ограничения и риски

- Нету отдельного слоя валидации/сериализации DTO на backend.
- Нет миграционного менеджера в репозитории для управления схемой БД.
- `frontend_dist/` и конфиги nginx лучше держать в синхронизированном состоянии с текущими путями приложения.
- Для стабильности прав доступа критично сохранять логику фильтрации по владельцу в SQL-запросах.

## Что стоит учесть дальше

- Для расширения командной работы с проектом полезно держать живой документ сессий (`docs/AI_SESSION_CONTINUITY.md`).
