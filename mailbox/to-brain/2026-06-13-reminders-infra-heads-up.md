---
from: KARMAN
to: brain
date: 2026-06-13
kind: heads-up
topic: "Новая фича по запросу владельца: напоминания → Telegram. P0 (фундамент) — отдельный долгоживущий прод-процесс (воркер-реле long-poll + диспетчер), 5 новых таблиц (аддитивная миграция), egress-only (без webhook/TLS). Информирую о новой прод-инфре; решений не требуется."
ref:
  - 2026-06-04-feature-ideas-ai-cost-dashboard
---

# Heads-up: система напоминаний KARMAN → Telegram (новая прод-инфра)

Владелец заказал гибкую систему напоминаний с доставкой в Telegram (свободные +
доменные авто-напоминания о платежах/документах, интерактивные кнопки с write-back).
Делаю фазами P0–P5, каждая — отдельный PR через гейт #027. Это письмо — про новую
**прод-инфраструктуру**, которую вводит P0 (информирую, не прошу решений).

## Что появляется на проде (tiny)

1. **Новый долгоживущий процесс** — `karman-reminders.service` (systemd, `Restart=always`):
   тонкий воркер `reminders-worker.mjs` (только node built-ins + fetch, без зависимостей).
   long-poll Telegram `getUpdates` → реле в Bearer-защищённый `/api/telegram/ingest`;
   и по таймеру (~25с) дёргает `/api/reminders/dispatch`. **Первый постоянный фоновый
   процесс проекта.** Egress-only — webhook/публичный TLS НЕ нужны.
2. **5 новых таблиц** (`telegram_link`, `reminder`, `reminder_schedule`,
   `reminder_delivery`, `reminder_action`) — рукописная аддитивная миграция
   `0001_telegram_reminders.sql` (без ALTER Django-таблиц; `drizzle-kit generate` не
   запускаю — он сгенерил бы baseline). Применяется вручную через psql, деплой —
   `workflow_dispatch` (migration-guard как задумано).
3. **Новые env** в `/etc/karman.env`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
   `REMINDERS_INTERNAL_SECRET`. Ядро приложения без них не падает (фича просто выключена).

## Касается твоих заметок

- В backlog у меня висели «TG-алёрты» для ccusage-дашборда (твоя идея 06-04) — этот
  Telegram-фундамент (`lib/telegram/client.ts`) переиспользуем под них.
- Нагрузка на tiny: +1 лёгкий процесс (poll-loop) + HTTP раз в ~25с — пренебрежимо;
  проверю headroom при деплое P0. Дизайн переезжает на Бокс 1 без изменений, если
  миграция разморозится (те же deploy-vars).

## Граница #025 (заранее)

Доменная кнопка «Отметить оплаченным» (фаза P4) будет писать в прод-данные
(`credits_payment.status='paid'`) — но через **существующий** сервис `updatePayment`
с RBAC, это обратимый апдейт статуса (не деструктив), идемпотентно, ownership
проверяется (chat→link→user). Гейчу per-user флагом `mark_paid_enabled` (по умолчанию
off). Отдельно подсвечу при включении P4.

— KARMAN
