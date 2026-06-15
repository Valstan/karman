# Session Handoff

> Sticky-note для непрерывности между сессиями KARMAN. Перезаписывается через
> `/close_session` — историю смотри через `git log --follow -- docs/SESSION_HANDOFF.md`.

**Status:** ACTIVE
**Updated:** 2026-06-15
**Branch:** main (нитка катовера — асинхронная, ждёт ответа brain)
**Прод:** tiny (`4ce93c2b59f9.vps.myjino.ru`). #32 (`0a3e2bf`) смержен 06-15 13:32 —
push в main триггерит `deploy-prod.yml` (в этой сессии деплой не верифицировал).
Бокс 1 (`831d0ce99bdf.vps.myjino.ru`) — слот готов с 06-11, трафик НЕ переключён.

---

## Текущая нитка

**Cutover KARMAN на Бокс 1: владелец дал go (директива brain 06-15), но Ф3 заблокирована
до координации с brain по 3 box-side пробелам.** Сделано read-only ревью текущего HEAD под Ф3:
- ✅ HEAD чистый (`0a3e2bf` = origin/main), миграция одна — `0001_telegram_reminders.sql` —
  **аддитивна** (CREATE-only, идемпотентна), **деструктива нет** → согласование не требуется.
- ⚠️ Слот Бокса 1 готовился **06-11**, до подсистемы напоминаний (P0 06-13 / реле 06-14 /
  тихие часы 06-15). Три пробела, которых нет в плане brain: (1) миграция `0001` не накачена
  на `karman_db` бокса; (2) env `/etc/karman/karman.env` без TG-переменных
  (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_API_BASE`,
  `REMINDERS_INTERNAL_SECRET`, опц. `REMINDERS_DISPATCH_INTERVAL_MS`/`APP_BASE_URL`/`MEDIA_ROOT`);
  (3) юнит воркера `karman-reminders.service` не установлен, и репо-версия под бокс не годится
  (там `/etc/karman.env`, `PORT=3000`, `/usr/bin/node` — на боксе `/etc/karman/karman.env`,
  `3002`, `/opt/node22/bin/node`).

Письмо координации отправлено: PR #33 (смержен) →
`mailbox/to-brain/2026-06-15-box1-cutover-reminders-infra-gaps.md`.

## Следующий шаг

1. **Дождаться ответа brain** (новые письма — `../brain_matrica/mailboxes/KARMAN/from-brain/`):
   кто закрывает 3 пробела на боксе (доступ к БД-роли/боксу у brain). До ответа Ф3 НЕ запускать —
   иначе напоминания на боксе лягут.
2. **Ф3 (после ответа):** правка 3 repo-vars (`gh variable set`): `DEPLOY_SSH_HOST` →
   `831d0ce99bdf.vps.myjino.ru`, `DEPLOY_SSH_PORT` → `22`, `DEPLOY_APP_PORT` → `3002`;
   затем деплой штатным workflow из HEAD → старт `karman`.
3. **Ф4-смок вместе с brain:** `https://831d0ce99bdf.vps.myjino.ru/api/health` + логин-флоу +
   `systemctl status karman-reminders` + тестовая привязка/доставка; доложить письмом результат
   и подтвердить, что накатилась только `0001`. Дальше Ф5 (дельта данных) — сторона brain.
4. **Независимо (если катовер ждёт):** фоновый аудит Zod v4 `optional*`-хелперов
   (`optionalMoney`/`optionalDateString` в схемах платежей/документов/кредитов — опускают ли
   формы ключи; тот же класс граблей G70/G54). Корневой фикс в `common.ts` + регрессия, если
   найдётся активный баг. Моя нитка по письму brain `2026-06-15-zod-v4-union-gotcha-pooled`.

## Контекст

- **План:** `C:\Users\Valstan\.claude\plans\soft-yawning-balloon.md` (отсутствует на диске — не блокер).
- **Связанные коммиты сессии:** `6032ffe` (письмо координации катовера) → PR #33 (смержен, `32f93b6`).
- **Открытые PR:** нет. **Открытые вопросы для пользователя:** нет (мяч у brain).
- **Ключевые письма:** входящее `from-brain/2026-06-15-cutover-go-deploy-current-head` (go на катовер,
  mandate); исходящее `to-brain/2026-06-15-box1-cutover-reminders-infra-gaps` (3 пробела);
  параметры слота — `from-brain/2026-06-11-box1-slot-ready-deploy-signal`.

## Failed approaches (этой нитки)

- **«Флипнуть 3 repo-vars + штатный деплой» как достаточный Ф3** — НЕ достаточно: слот Бокса 1
  старше подсистемы напоминаний, поэтому деплой кода без (а) миграции `0001`, (б) env-переменных
  напоминаний, (в) адаптированного юнита воркера поднимет приложение, но положит напоминания.
  Письма brain (06-11/06-15) писались до того, как напоминания доехали в прод — пробел в плане.

## Не забыть (low-priority)

Канонический список с метками — `docs/PENDING_FOLLOWUPS.md`. Витрина: катовер на Бокс 1 (Ф3→Ф8,
ждёт координации brain); аудит Zod v4 `optional*` (фоновый, моя нитка); P3-хвосты остаток
(праздники / календарь UI / произвольные даты); P5 напоминаний; глобальный `/payments` или
удаление `listPayments`; удалить тестовое напоминание id 1 на проде; ESLint; бэкап `media/`;
квартальный самоосмотр Q3 2026.
