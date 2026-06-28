# Session Handoff

> Sticky-note для непрерывности между сессиями KARMAN. Перезаписывается через
> `/close_session` — историю смотри через `git log --follow -- docs/SESSION_HANDOFF.md`.

**Status:** ACTIVE
**Updated:** 2026-06-29
**Branch:** main
**Прод:** **Бокс 1** (`831d0ce99bdf.vps.myjino.ru`, PostgreSQL 16, app :3002), HEAD main.
В проде за сессию: ESLint-гейт, миниатюры сканов, календарь срабатываний, произвольные даты
напоминаний, **менеджер секретов (чтение + запись по токену)**. `karman` + `karman-reminders` active.

---

## Текущая нитка

**Менеджер секретов KARMAN — построен и в проде**, включая **запись по токену** (read-write токены
`can_write`, `POST /api/secrets`; read — `GET`). Шифрование AES-256-GCM, мастер-ключ в env.
UI `/secrets` (проекты → секреты + токены + аудит). Runbook — `docs/secrets-manager.md`,
клиентский гайд для проектов — `docs/secrets-client-guide.md`.

**Онбординг проекта `trener`:** заведён проект + read-write токен (round-trip проверён в проде);
владельцу выдан paste-message с токеном + ссылкой на гайд, чтобы агент trener сам подключился
(сохранять/читать свои секреты). Дальнейшая интеграция — на стороне trener.

**SSH к Боксу 1 — есть** (выделенный ключ `id_ed25519_karman`); прод-операции self-serve.
KARMAN между нитками: новых директив brain нет.

## Следующий шаг

1. **Если агент trener вернётся с вопросом/ошибкой** по интеграции — помочь (контракт —
   `docs/secrets-client-guide.md`; токен trener бессрочный, ротация в `/secrets`).
2. **Следующая фича/backlog — по запросу владельца** (`docs/PENDING_FOLLOWUPS.md`).
3. **Прод-операции self-serve** (память `project-prod-box1`): миграция
   `ssh karman 'set -a; . /etc/karman/karman.env; set +a; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f -' < lib/db/migrations/000X.sql`;
   деплой `gh workflow run deploy-prod.yml`. Деструктив на живых данных — подтверждение владельца (#025).

## Контекст
- **План:** нет.
- **Связанные PR сессии:** #42–#56 — payments-хвост, ESLint (#43), миниатюры (#44), календарь (#45),
  произвольные даты (#47), менеджер секретов (#48), запись по токену (#54), trener+гайд (#55/#56);
  письма brain #49/#51/#52/#56. Всё смержено / в проде.
- **Открытые PR:** нет (кроме этого handoff-PR).
- **Открытые вопросы для пользователя:** живой TG-тест кнопки (опц.); интеграция trener — на его стороне.

## Failed approaches / исправленные заблуждения

- **«Нет SSH к Боксу 1» — было ОШИБКОЙ.** Доступ есть: `ssh karman` → выделенный
  `~/.ssh/id_ed25519_karman` (`valstan@831d0ce99bdf`). Старый алиас `karman` вёл на мёртвый tiny.
  `valstan` — не роль в Postgres → для psql источать `/etc/karman/karman.env` (роль `karman_app`).

## Не забыть (low-priority)

Канонический список — `docs/PENDING_FOLLOWUPS.md`. Витрина: живой TG-тест кнопки (владелец);
удалить тестовое напоминание id 1 (могу сам по SSH, но DELETE → подтверждение #025); P3-хвосты
напоминаний (праздники / cron); P5 (богатый контент); бэкап `media/`; per-app-изоляция
секрет-доступа (отдельный OS-юзер + sudoers, нужен root); secrets — TTL/scoped токены, ротация
мастер-ключа, CLI, экспорт/импорт `.env` (по запросу); квартальный самоосмотр Q3 2026.
