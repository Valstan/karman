# Session Handoff

> Sticky-note для непрерывности между сессиями KARMAN. Обновляется в том же PR, что и шаг
> работы (D-066); переписан целиком `/close_session` 2026-09-12 — историю (в т.ч. подробности
> 11.09: `karman-tg`, G331, D-078) смотри через `git log --follow -- docs/SESSION_HANDOFF.md`.

**Status:** IN_PROGRESS
**Updated:** 2026-09-14
**Branch:** `main`
**Прод:** код `ddbb8c2` (#145), `next` 16.3.5, миграции `0014`–`0017` применены (0017 —
через `sudo -u postgres`, таблица легаси). На вечер 12.09: оба юнита `active`, `health=200`,
в env сервиса добавлены `MEDIA_ROOT` и `ECOSYSTEM_MAP_FILE`, в `media/` 81 скан.

---

## Текущая нитка

**D-090 — «Карта проектов» со вкладками из репо Мозга — сделано и на проде** (#147).
14.09 владелец получил PAT вместе с Мозгом и сам вписал `BRAIN_MAP_GITHUB_TOKEN` в env бокса;
проверено: три вкладки на экране владельца, все четыре файла `docs/map/` читаются по токену
(200), `ECOSYSTEM_MAP_FILE` и `ecosystem-map.json` с бокса убраны. Отчёт Мозгу отправлен
(`mailbox/to-brain/2026-09-14-d090-…` + строка «на проде»). D-086 закрыт той же строкой.

## Следующий шаг

`project_deleted` в аудит секретов — сделано (PR ниже): `deleteProject` в транзакции
пишет строку `project_id = NULL`, `detail = slug=… audit=N tokens=M items=K`,
`actor = owner:<id>`, и только потом `DELETE`. Строка Мозгу — после деплоя. Дальше:

1. Дайджест Мозга 12.09 (ack none): наше — #312 (`npm audit` по расписанию, не только в PR),
   G340 (проверить, что метрик/Вебвизора на страницах после входа нет).
2. Смоук владельца по #145 (документы, новый интерфейс) — всё ещё не сделан глазами.

## Контекст

- **Планы и контракты:** `docs/ecosystem-map.md` (карта: формат, обновление), `docs/OPERATIONS.md`
  (`MEDIA_ROOT` обязателен при раскладке `releases/<sha>`), `docs/secrets-client-guide.md`,
  `docs/passport-server.md`, `docs/esa-login.md`, `docs/telegram-reminders.md`.
- **Аккаунты прода:** `admin` (id 1, superuser, привязан к ЕСА), `Valstan` (id 17, отключён),
  `Chaka` (id 29). Документы семьи — все в `admin`, различаются полем `holder`.
- **Комнаты секретов:** 11. Личности паспорта: 1 trener, 2 Gonba, 3 Sabantuy, 4 Kazanskaya,
  5 vMalmyzhe, 6 DKMalmyzh.
- **Открытые PR:** нет. **Открытые вопросы для владельца:** где единственная копия
  закрытого gpg-ключа и `SECRETS_MASTER_KEY` (висит с августа).
- **Почта brain:** четыре письма 12.09 пришли после закрытия сессии 12.09 — см. «Текущая
  нитка». Отправлены 12.09: отчёт по карте (#141, теперь заменён D-090) и идея про `MEDIA_ROOT`.

## Не забыть (low-priority)

Канонический список — `docs/PENDING_FOLLOWUPS.md`. Витрина: **смоук владельца** (документы,
новый интерфейс, печать); **легаси-cookie** снять после 18.09; **R1**; **G321**; **гейт таблиц
бэкапа**; deadcode — октябрь. Фото для карточек: документ вида «Фотография» у каждого человека.

## Прод-инфра (для следующей сессии)

- **ssh:** алиасы `karman` и `GONBA`. Первый коннект может отвалиться — повторить.
  Деструктив по прод-БД — только с подтверждением владельца в том же ходе (#025).
- **Порт приложения — 3002**, в юните. Env-файл сервиса — см. `EnvironmentFile` юнита
  (`/etc/karman` root-only: бэкап env туда не положить, сам файл владельца).
- **psql по ssh (D-046):** SQL в файл → `ssh karman 'cat > /tmp/<файл>' < <файл>` →
  `ssh karman 'envf=$(systemctl show karman -p EnvironmentFiles --value | cut -d" " -f1); set -a; . "$envf"; psql "$DATABASE_URL" -f /tmp/<файл>'`.
  `\pset pager off` первой строкой. Временные файлы с персональными данными — удалять с бокса.
- **Легаси-таблицы Django-эпохи принадлежат `postgres`:** `ALTER` на них —
  `db=${DATABASE_URL##*/}; sudo -n -u postgres psql -d "${db%%\?*}" -f /tmp/<файл>`.
- **Миграции:** guard роняет авто-деплой → применить psql → `gh workflow run deploy-prod.yml --ref main`.
- **`gh`/`git` рвутся TLS-таймаутом** — всё сетевое в цикл повторов; мерж проверять
  `gh pr view N --json state`. Фоновые ожидания `gh run` могут зависнуть — проверять
  `gh run view <id>` напрямую. Авто-мерж не включён — `gh pr merge --squash` по зелёному.
- **Фоновые цепочки без `git checkout`** (см. память): `checkout`/`pull` — только в foreground.
- **`npm audit fix --omit=dev` сносит dev-пакеты** — после него `npm install`.
- **Локальной базы нет** — проверять сборкой, тестами, гейтом; страница входа доступна в
  превью `.claude/launch.json` (порт 3100) и без БД.
- **`main` защищён:** required check `gates`, PR обязателен, `enforce_admins`.
- **Бэкап vault:** cron 03:30, `scripts/backup_vault.sh`; `BACKUP_MEDIA_ROOT` = `MEDIA_ROOT`.
