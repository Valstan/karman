# Session Handoff

> Sticky-note для непрерывности между сессиями KARMAN. Перезаписывается через
> `/close_session` — историю смотри через `git log --follow -- docs/SESSION_HANDOFF.md`.

**Status:** ACTIVE
**Updated:** 2026-06-30
**Branch:** main
**Прод:** **Бокс 1** (`831d0ce99bdf.vps.myjino.ru`, PostgreSQL 16, app :3002), HEAD main `4d8f78c`
(docs-only #58 — **без редеплоя**, `deploy-prod.yml` игнорит `docs/**`). Менеджер секретов LIVE:
**10 комнат** (9 экосистемных + trener), read-write токены. `karman` + `karman-reminders` active.

---

## Текущая нитка

**Менеджер секретов — комнаты заведены для всей экосистемы (#58, 2026-06-30).** Под владельцем
(`auth_user.id 17`) созданы 9 комнат + read-write токен на каждую: `matricarmz`, `gonba`,
`setka`(SARAFAN), `sabantuymalmyzh`, `vmalmyzhe`, `dkmalmyzh`, `kalininocks`, `brain`, `karman`
(`trener` был раньше). Bootstrap: токены сгенерены **локально** (алгоритм 1-в-1 с
`lib/secrets/token.ts`), в БД ушёл только `token_hash`+`token_prefix` аддитивным `INSERT` по SSH;
plaintext выдан владельцу в чате **один раз** (в репо/git/память НЕ кладём, креды с диска вычищены).
Живая проверка: валидный токен `GET → 200 {}`, мусорный → `401`.

**Универсальный онбординг-гайд** `docs/secrets-client-guide.md` доведён до самодостаточного:
«каждому проекту своя комната», список slug'ов, хендшейк (токен → env `SECRETS_TOKEN`),
smoke-проверка, сниппеты Node + Python + curl. Любой проект, прочитав его, подключается к своей
комнате. Рунбук `docs/secrets-manager.md` — заметка о комнатах.

## Следующий шаг

1. **Раздача токенов проектам — на стороне владельца** (положить каждому в рантайм-env
   `SECRETS_TOKEN`, не коммитить). Интеграция (save/load своих ключей) — на стороне каждого проекта,
   как с trener; контракт — `docs/secrets-client-guide.md`.
2. **Если проект вернётся с вопросом/ошибкой** по подключению — помочь.
3. **Следующая фича/backlog — по запросу владельца** (`docs/PENDING_FOLLOWUPS.md`).
4. **Прод-операции self-serve** (память `project-prod-box1`): миграция
   `ssh karman 'set -a; . /etc/karman/karman.env; set +a; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f -' < lib/db/migrations/000X.sql`;
   деплой `gh workflow run deploy-prod.yml`. Деструктив на живых данных — подтверждение владельца (#025).

## Контекст
- **План:** нет.
- **Связанные коммиты сессии:** `4d8f78c` (#58 — комнаты экосистемы + универсальный онбординг-гайд).
- **Открытые PR:** нет (кроме этого handoff-PR).
- **Открытые вопросы для пользователя:** раздать токены проектам + per-project интеграция (на их
  стороне); живой TG-тест кнопки (опц., с прошлой нитки).

## Failed approaches / исправленные заблуждения

- **Слаг комнаты в `/secrets` — только `[a-z0-9-]`, без подчёркиваний** (zod-регекс в
  `lib/validation/secret.ts`). Поэтому `brain_matrica` завели как slug `brain`. Прямой `INSERT` в
  обход zod это бы не поймал — сверять с валидатором перед bulk-bootstrap.

## Не забыть (low-priority)

Канонический список — `docs/PENDING_FOLLOWUPS.md`. Витрина: раздать токены + интеграция проектов
в менеджер секретов; живой TG-тест кнопки (владелец); удалить тестовое напоминание id 1 (DELETE →
подтверждение #025); P3-хвосты напоминаний (праздники / cron); P5 (богатый контент); бэкап `media/`;
per-app-изоляция секрет-доступа (отдельный OS-юзер + sudoers, нужен root); secrets — TTL/scoped
токены, ротация мастер-ключа, CLI, экспорт/импорт `.env` (по запросу); квартальный самоосмотр Q3 2026.
