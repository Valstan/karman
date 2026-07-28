# Session Handoff

> Sticky-note для непрерывности между сессиями KARMAN. Перезаписывается через
> `/close_session` — историю смотри через `git log --follow -- docs/SESSION_HANDOFF.md`.

**Status:** IDLE
**Updated:** 2026-07-29
**Branch:** main
**Прод:** Бокс 1 (`831d0ce99bdf.vps.myjino.ru`, PG16, app :3002). Задеплоен `ca006ac`
(#78, first-token режим; `80604c5` — доки/почта, в `paths-ignore`, артефакт не трогает).
Миграций в сессии не было. В vault 12 комнат, `secrets_grant` — 1 действующая выдача.

---

## Текущая нитка

_Нет — мандат brain 2026-07-28 (ADR-0010) закрыт со своей стороны за сессию._
`POST /api/secrets/provision` на существующий slug больше не тупик: пустая комната
с ни разу не использованными токенами получает первый рабочий rw-токен (старые
отзываются, аудит `provision_first_token`); живая комната — прежний `409`.
Оба живых блокера экосистемы (`vmalmyzhe`, `setka`) разблокированы, дальше проекты
онбордятся сами — без единого клика владельца.

## Следующий шаг

Работа по запросу владельца. Само придёт в очередь:
- **Замыкание конвейера ВК → портал → setka** — от нас действий не требуется: портал берёт
  токен через provision и зеркалирует `GATEWAY_KEY_VMALMYZHE`, `setka` берёт токен и читает
  по заранее оформленной выдаче (`secrets_grant` id 2, alias `VMALMYZHE_INGEST_KEY`).
  Проверка, что круг замкнулся: `ssh karman` → `set -a; . /etc/karman/karman.env;
  psql "$DATABASE_URL" -c "select * from secrets_item i join secrets_project p
  on p.id=i.project_id where p.slug='vmalmyzhe'"`.
- **Квартальный самоосмотр Q3 2026** (авг–сен) — окно открывается, помечен `recurring`.
- **deadcode-гигиена** — ритм месяц от 2026-07-10, следующий прогон в августе.

## Контекст

- **Связанные коммиты сессии:** `ca006ac` (#78 — first-token в `lib/services/secrets.ts`
  → `provisionFirstToken`, доки клиента и менеджера), `80604c5` (#79 — письмо brain с
  исправленным диагнозом + PENDING).
- **План:** — (модель — `docs/secrets-manager.md`, контракт клиентов —
  `docs/secrets-client-guide.md` → «Self-serve onboarding»).
- **Открытые PR:** нет (кроме этого handoff-PR).
- **Открытые вопросы для пользователя:** нет.

## Не забыть (low-priority)

Канонический список — `docs/PENDING_FOLLOWUPS.md`. Витрина: **migration-guard защищает один
push, а не инвариант** (тех-долг, идея #099 мозга); бэкап `media/` на проде — единственный
пункт с риском потери данных, поднять владельцу; квартальный самоосмотр Q3; deadcode ~август.

## Прод-инфра (для следующей сессии)

- **ssh на Бокс 1 есть:** алиасы `karman` и `GONBA` (ключ `id_ed25519_gonba_deploy`).
  Деструктив на прод-БД — только с подтверждением владельца в том же ходе (#025).
- **Грабля psql по ssh (уточнено 07-29):** `$DATABASE_URL` в env юзера НЕТ — переменные лежат
  в `/etc/karman/karman.env` (из systemd-юнита `karman`). Рабочая форма:
  `ssh karman 'set -a; . /etc/karman/karman.env; psql "$DATABASE_URL" -c "…"'`.
  Строки с `$` в двойных кавычках раскрывает удалённый шелл — литералы слать как `$$…$$`
  (экранируя `\$\$`) или SQL целиком через stdin (`… psql "$DATABASE_URL" -f -' < file.sql`).
- **HTTP снаружи:** прод-эндпойнты проверять curl'ом **с бокса** (`http://127.0.0.1:3002`);
  веб-UI из браузера на PC40 открывается нормально (вход владельца: пароль + 2FA — он сам).
- **Миграции:** `deploy-prod.yml` блокирует авто-деплой на коммите с новой миграцией →
  применить psql'ом с машины, затем `gh workflow run deploy-prod.yml --ref main`. Осторожно:
  guard видит только последний коммит (тех-долг выше).
- **Vault:** `POST /api/secrets/provision` под `VAULT_PROVISION_KEY` — заводит комнату И
  выдаёт первый токен нетронутой комнате (ADR-0010). Выдача доступа между комнатами (grant) —
  GUI владельца под 2FA. Бэкап vault: cron 03:30, `scripts/backup_vault.sh`.
