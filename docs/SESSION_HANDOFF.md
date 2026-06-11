# Session Handoff

> Sticky-note для непрерывности между сессиями KARMAN. Перезаписывается через
> `/close_session` — историю смотри через `git log --follow -- docs/SESSION_HANDOFF.md`.

**Status:** ACTIVE
**Updated:** 2026-06-11
**Branch:** main (PR #18 и #19 смержены)
**Прод:** `328ddb0` через **CI-artifact** (`releases/328ddb0…`, симлинк `current`), health ok.
redis+memcached погашены (disable, не purge). Деплой теперь — workflow `deploy-prod.yml`
на push в main; on-box build удалён.

---

## Текущая нитка

**Миграция на Бокс 1 (мандат brain 06-11, KARMAN едет первым).** Наша Ф3-часть готова:
CI-artifact-деплой работает (PR #18, боевой прогон зелёный), redis/memcached погашены,
ответы brain отправлены (PR #19: домен не нужен — техдомен Бокса 1; env → #008 при переезде).
**Ждём сигнал Мозга после Ф0–Ф2** (снапшот, слот на Боксе 1, перенос media+БД).

## Следующий шаг

1. Проверить почту brain (`../brain_matrica/mailboxes/KARMAN/from-brain/` — читать с диска,
   без pull) — пришёл ли сигнал Ф1/Ф2 со слотом Бокса 1.
2. Если сигнал есть — смена deploy-target: vars `DEPLOY_SSH_HOST`/`DEPLOY_SSH_PORT`,
   `DEPLOY_APP_PORT`→3002 (`gh variable set …`), pubkey `karman-ci-deploy` юзеру `valstan`
   на Боксе 1, env → `/etc/karman/karman.env` (#008), затем `workflow_dispatch` деплой + смок.
   Baseline-DDL на новом боксе НЕ выполнять (детали — в PENDING_FOLLOWUPS).
3. Если сигнала нет — свободная задача: #036 knip+depcheck (`docs/PENDING_FOLLOWUPS.md`).

## Контекст

- **План:** `../brain_matrica/docs/plans/server-migration-playbook.md` (роли: Мозг — данные,
  мы — deploy-target).
- **Связанные коммиты сессии:** `328ddb0` (PR #18, CI-artifact-деплой), `31c7ecb` (PR #19,
  ack brain + followups).
- **Открытые PR:** нет.
- **Открытые вопросы для пользователя:** нет.

## Failed approaches (этой нитки)

_Не было._

## Не забыть (low-priority)

Канонический список — `docs/PENDING_FOLLOWUPS.md`. Витрина: #036 knip; смена deploy-target
по сигналу Мозга; ESLint-гейт; бэкап `media/`; #035 Ф2/Ф3.
