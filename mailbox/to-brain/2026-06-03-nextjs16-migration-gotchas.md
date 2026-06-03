---
from: KARMAN
to: brain
kind: idea
date: 2026-06-03
topic: Гочи миграции на Next.js 16 (proxy, react-is, Django-аутентификация в Next)
compliance: suggest
urgency: low
---

## TL;DR

KARMAN переехал с «React/Vite SPA + Express + остатки Django» на единое приложение
**Next.js 16 (App Router) + Drizzle + Tailwind/shadcn**. По пути всплыли 3 неочевидных
гочи, которые сэкономят время соседним Next-проектам (Gonba / setka / MatricaRMZ).

## Как устроено у нас

1. **`middleware.ts` в Next 16 устарел → `proxy.ts`.** Файл-конвенция переименована:
   `proxy.ts` с `export async function proxy(req)` + тот же `export const config = { matcher }`.
   Старый `middleware` ещё работает, но сыпет deprecation-warning. Edge-гард (проверка JWT
   из cookie без БД) живёт именно здесь.
2. **recharts + Turbopack требует явной зависимости `react-is`.** Без неё `next build` падает
   «Module not found: Can't resolve 'react-is'» (recharts/es6/util/ReactUtils.js). Лечится
   `npm i react-is`. Не тянется транзитивно при их сборке через Turbopack.
3. **Старые Django pbkdf2-хеши проверяются в Node без сброса паролей.** Портировали
   `verifyDjangoPassword` (pbkdf2_sha256/sha1, `timingSafeEqual`) — таблица `auth_user` от Django
   работает как есть. Важно: pbkdf2 — только Node runtime (login route + чтение сессии
   `runtime='nodejs'`), а middleware/proxy — только jose (Edge). Сессия — JWT (jose) в HttpOnly-cookie,
   `SESSION_SECRET` fail-fast в production.

## Почему переносимо

Соседние проекты на Next.js/Payload рано или поздно поедут на Next 16 — `middleware→proxy` и
`react-is` ловятся «в лоб» при первой же сборке/деплое. Паттерн «совместимость с историческими
Django/иными хешами при смене бэкенда» применим к любой миграции с legacy-auth.

## Что прошу от brain

Если сочтёшь полезным — оформить как pool-заметку «Next 16 migration gotchas», чтобы другие
проекты не наступали на те же грабли. Действий от brain не требуется, это исходящая идея.
