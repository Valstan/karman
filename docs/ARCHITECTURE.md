# Архитектура KARMAN

## Обзор

Единое приложение **Next.js (App Router)**: фронтенд и бэкенд в одном TypeScript-проекте,
один процесс за nginx. PostgreSQL — через **Drizzle ORM**.

```
Браузер → nginx (TLS, :443) → Next.js (node, 127.0.0.1:3000) → PostgreSQL (unix-socket)
```

## Слои

- `app/` — маршруты App Router.
  - `(auth)/login` — страница входа (вне гарда).
  - `(app)/*` — защищённые страницы (дашборд, кредиты, банки, документы). Гард в `(app)/layout.tsx`.
  - `api/auth/{login,logout}`, `api/health` — Route Handlers (Node runtime).
- `proxy.ts` — Edge-гард (Next 16 «proxy», ранее middleware): дешёвая проверка JWT, редиректы.
- `lib/db/` — `schema.ts` (Drizzle, отражает существующие таблицы), `client.ts` (пул pg).
- `lib/auth/` — `password.ts` (Django pbkdf2), `jwt.ts` (jose, Edge-safe), `session.ts` (cookie),
  `current-user.ts` (`getCurrentUser` + БД, обёрнут в `cache()`), `rbac.ts` (`ownership`).
- `lib/services/` — доступ к данным на **чтение** (вызывается из RSC).
- `lib/actions/` — **мутации** (Server Actions): auth → validate (Zod) → service → `revalidatePath`.
- `lib/validation/` — Zod-схемы. `lib/schedule`/`money`/`dates` — чистая бизнес-логика.

## Поток данных

- **Чтение:** серверный компонент страницы вызывает `lib/services/*` напрямую (без клиентского fetch).
- **Запись:** клиентская форма (react-hook-form) → Server Action в `lib/actions/*` →
  Zod-валидация → сервис (Drizzle) → `revalidatePath('/', 'layout')` → `router.refresh()`.

## Аутентификация и доступ

- Пароли: `verifyDjangoPassword` (pbkdf2_sha256 / pbkdf2_sha1) — совместимость с историческими хешами.
- Сессия: JWT (HS256, `jose`) в HttpOnly-cookie `karman_session_v2`, срок 14 дней.
- Гард в два слоя: `proxy.ts` (Edge, без БД) + `(app)/layout.tsx` (`getCurrentUser`, ловит `is_active`).
- Фильтрация по владельцу: `ownership(user, column)` — для superuser фильтр снимается.
  Владение платежом — через join к `credits_credit.user_id` (на `credits_payment` нет `user_id`).

## Данные

Таблицы (исторически от Django): `auth_user`, `credits_bank`, `credits_credit`,
`credits_payment`, `documents_document`. Денежные поля (`numeric`) читаются **строками**
(конвенция против float-дрейфа). Даты — строками `YYYY-MM-DD`.

## Новый функционал

- **Автогенерация графика** (`lib/services/schedule.ts`): аннуитет/дифференцированный/нулевая
  ставка, математика в копейках, последний платёж добирает округление. Перегенерация не трогает
  оплаченные платежи.
- **CRUD банков** (общий справочник; удаление блокируется при наличии кредитов) и **документов**.
- **Графики дашборда** (Recharts): статусы кредитов, остаток по банкам.

## Ограничения

- Схема `lib/db/schema.ts` написана по фактическим колонкам и **должна быть сверена** с боевой
  БД через `npm run db:pull` на клоне перед прод-деплоем (см. OPERATIONS.md).
- Файлового хранилища для документов нет — только метаданные.
