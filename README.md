# KARMAN

Личный учёт кредитов: банки/МФО, кредиты, графики платежей, документы.

Единое приложение на **Next.js 16 (App Router) + TypeScript**, **Drizzle ORM** поверх
PostgreSQL, **Tailwind CSS + shadcn/ui**. Чтение — через React Server Components,
мутации — через Server Actions с валидацией Zod.

## Стек

- **Next.js 16** (App Router, standalone-сборка) + React 19 + TypeScript
- **Tailwind CSS v4 + shadcn/ui** (тема light/dark через next-themes)
- **Drizzle ORM** + drizzle-kit (PostgreSQL)
- **Recharts** — графики на дашборде
- **jose** — сессии (JWT в HttpOnly-cookie); пароли — Django-совместимый pbkdf2
- **Zod** — валидация всех мутаций
- **Vitest** — юнит-тесты (генерация графика, пароли, деньги)

## Структура

```
app/          маршруты: (auth)/login, (app)/{дашборд,credits,banks,documents}, api/{auth,health}
components/   ui/ (shadcn) и app/ (компоненты приложения)
lib/          db/ (схема+клиент), auth/, services/ (чтение), actions/ (мутации), validation/ (zod)
scripts/      bootstrap.sql (локальная БД), deploy.sh, karman.service, nginx.karman.conf
docs/         ARCHITECTURE.md, OPERATIONS.md
```

## Локальная разработка

Боевая БД недоступна с dev-машины — поднимаем локальный PostgreSQL в Docker
(схема и тестовые данные применяются автоматически из `scripts/bootstrap.sql`):

```bash
cp .env.example .env.local      # при необходимости поправьте значения
docker compose up -d            # PostgreSQL на localhost:5432
npm install
npm run dev                     # http://localhost:3000
```

Вход в dev-режиме: **admin / admin123**.

## Проверки

```bash
npm run build       # сборка + проверка типов
npm run test        # юнит-тесты
npm run typecheck   # только типы
```

## Прод-сборка и деплой

См. [docs/OPERATIONS.md](docs/OPERATIONS.md). Кратко:

```bash
scripts/deploy.sh   # git pull → npm ci → build → (migrate) → restart karman.service
```

Приложение работает одним процессом `node .next/standalone/server.js` на `127.0.0.1:3000`
за nginx (`scripts/nginx.karman.conf`), systemd-юнит — `scripts/karman.service`.

## Переменные окружения

| Переменная | Назначение |
|------------|-----------|
| `DATABASE_URL` | строка подключения PostgreSQL (на сервере — unix-socket) |
| `SESSION_SECRET` | секрет подписи JWT-сессий. **Обязателен в production** (иначе сервис не стартует) |
| `NODE_ENV` | `development` / `production` |

## Аутентификация

- Пользователи — таблица `auth_user` (создана исторически в Django).
- Пароли проверяются в формате Django `pbkdf2_sha256` (существующие хеши работают без сброса).
- Сессия — подписанный JWT в HttpOnly-cookie `karman_session_v2`.
