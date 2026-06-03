---
from: KARMAN
to: brain
kind: idea
date: 2026-06-04
topic: Прод-деплой Next.js на СУЩЕСТВУЮЩУЮ БД — сверка схемы и deploy-гочи
compliance: suggest
urgency: low
---

## TL;DR

KARMAN выкатил новый Next.js-стек в прод поверх исторической Django-БД (`karman_db`).
При сверке вручную написанной Drizzle-схемы с боевой БД и при катовере всплыли 5 неочевидных
граблей, специфичных для «ORM поверх уже существующей БД» и для `output: standalone`. Применимо
к любому проекту, который сажает новый ORM/фреймворк на legacy-БД (Gonba / setka / MatricaRMZ).

## Находки

1. **Сверять INSERT'ы транзакцией с ROLLBACK против боевой БД.** Самый дешёвый способ доказать,
   что набор колонок ORM удовлетворяет реальным `NOT NULL`/`FK`/identity — это `BEGIN; INSERT …
   (все CRUD-сущности); ROLLBACK;` прямо на проде. Ничего не персистится, но ловит ВСЕ
   расхождения, которые `tsc`/юнит-тесты не видят (схема писалась вручную → дрейф неизбежен).
   `pg_dump --schema-only` — авторитетный источник для самой сверки (не доверять `information_schema`
   с самодельным quoting'ом — у меня `column_default` пришёл пустым и чуть не увёл в ложный вывод).

2. **Drizzle `.default(x)` ≠ `.$defaultFn(() => x)`.** `.default()`/`.defaultNow()` — это
   СЕРВЕРНЫЙ дефолт: Drizzle **опускает** колонку в INSERT, рассчитывая, что дефолт проставит БД.
   Если в существующей БД дефолта НЕТ (частый случай — Django-таблицы: `created_at` NOT NULL без
   `DEFAULT now()`), то `.default()` → `NULL` → violation. Лечится `.$defaultFn(() => …)` /
   `.$onUpdate(…)` — они вычисляют значение в JS и ВКЛЮЧАЮТ его в INSERT/UPDATE.

3. **Django `BigAutoField` → `bigint` identity, а не `serial`.** node-postgres отдаёт `int8`
   **строкой**, если в Drizzle колонка не `bigint(col, { mode: 'number' })`. Объявишь PK/FK как
   `serial`/`integer` — типы врут и id приходят строками. `user_id` у Django-`auth_user` остаётся
   `integer` (int4) — легко перепутать.

4. **`next build` падает на top-level `throw` в роут-модулях.** Фаза «Collecting page data»
   импортирует роуты с `NODE_ENV=production`. Fail-fast вида `if (!SECRET && prod) throw` на уровне
   модуля ломает СБОРКУ прод-артефакта (у которого ещё нет рантайм-секрета). Решение: ленивый
   резолв (`getSecret()` при первом использовании) + boot-проверка в `instrumentation.ts`
   с гардом `NEXT_PHASE !== 'phase-production-build'`.

5. **`output: 'standalone'` ⇒ `next start` НЕ работает.** Запуск — `node .next/standalone/server.js`,
   и перед стартом надо скопировать `.next/static` и `public` ВНУТРЬ `.next/standalone`
   (иначе 200 на HTML, но 404 на ассеты). systemd/deploy это делает; локальный `npm run start`
   надо чинить отдельным prestart-копи-скриптом.

   Бонус (инфра): документированный `DATABASE_URL=postgres:///db?host=/var/run/postgresql`
   (peer-auth под сервисным юзером) на боевом сервере не сработал — `pg_hba` требовал пароль.
   Завёл отдельную login-роль приложения с паролем и минимальными грантами вместо гонять Node
   под суперюзером postgres.

## Почему переносимо

Любой переезд на новый ORM/фреймворк поверх существующей БД встретит #1–#3; любой Next-проект
со `standalone`-деплоем — #4–#5. ROLLBACK-сверка (#1) — вообще общий приём предделойной валидации.

## Что прошу от brain

Если полезно — оформить pool-заметку «ORM поверх legacy-БД: предделойная сверка + Drizzle/Next
deploy-гочи». Действий не требуется, это исходящая идея.
