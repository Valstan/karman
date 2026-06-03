# Session Handoff

> Sticky-note для непрерывности между сессиями KARMAN. Перезаписывается через
> `/close_session` — историю смотри через `git log --follow -- docs/SESSION_HANDOFF.md`.

**Status:** ACTIVE
**Updated:** 2026-06-03
**Branch:** main
**Прод:** старый стек (ещё не задеплоен новый) — деплой ждёт сверки схемы БД. **PR #3 СМЕРЖЕН в main** (`27761cc`).

---

## Текущая нитка

Глубокий рефакторинг KARMAN завершён и **смержен в `main`**: перевод со связки
«React/Vite SPA + Express + остатки Django» на **единое приложение Next.js 16 (App Router) +
TypeScript + Drizzle ORM + Tailwind/shadcn**. Осталось выкатить на прод.

## Следующий шаг

1. **Перед прод-деплоем — сверить схему БД** (КРИТично): на клоне/дампе боевой БД выполнить
   `DATABASE_URL=... npm run db:pull` и привести `lib/db/schema.ts` в соответствие (схема писалась
   вручную по колонкам из старого `api/server.js`, реальную БД с dev-машины не видели).
2. **Деплой** (см. `docs/OPERATIONS.md`): `scripts/deploy.sh`; переключить systemd на
   `scripts/karman.service`, nginx — на `scripts/nginx.karman.conf` (проброс `X-Forwarded-Proto`);
   задать `SESSION_SECRET` в `/etc/karman.env`; отключить старый `karman-api.service`.

## Контекст

- **План:** `C:\Users\valstan\.claude\plans\declarative-frolicking-dewdrop.md` (утверждён).
- **Связанные коммиты сессии:** `1c84327` каркас Next.js · `a9603c3` Drizzle · `3149108` auth ·
  `ad752a2` логика/сервисы/действия/тесты · `fb46af0` UI · `239a28c` очистка legacy + деплой/доки.
- **Открытые PR:** нет (PR #3 смержен squash'ем в `main` = `27761cc`).
- **Открытые вопросы для пользователя:** нет.

## Failed approaches (этой нитки)

- **Полный e2e против реальной БД локально не гонялся** — на dev-машине (Windows) нет ни Docker,
  ни локального Postgres. Проверено: `next build` (зелёный), 18 юнит-тестов (график/пароли/деньги),
  рендер страницы входа. БД-зависимый e2e — через `docker compose up -d` там, где есть Docker.
- **`middleware.ts` в Next 16 устарел** → переименовано в `proxy.ts` (функция `proxy`). Не возвращать `middleware`.
- **recharts с Turbopack требует явной зависимости `react-is`** — без неё сборка падает «Can't resolve 'react-is'».

## Не забыть (low-priority)

- Cookie сессии переименован (`karman_session_v2`) → при первом заходе на новом стеке будет разовый релогин.
- `SESSION_SECRET` обязателен в production (иначе сервис намеренно не стартует).
- Схема `lib/db/schema.ts` помечена как «сверить через db:pull» — снять пометку после сверки.
