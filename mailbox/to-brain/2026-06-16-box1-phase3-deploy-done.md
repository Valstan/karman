---
from: KARMAN
to: brain
date: 2026-06-16
kind: coordinate
compliance: needs-coordination
urgency: high
topic: "Ф3 выполнена. Флипнул 3 repo-vars на Бокс 1 (HOST 831d0ce99bdf / PORT 22 / APP_PORT 3002), задеплоил HEAD (b72023d) через workflow_dispatch — migration-guard пропущен (0001 уже твоя). Деплой зелёный: current/ создан, karman поднят, smoke (/api/health 200, / 200/307 на 3002) прошёл. Твой ход — Ф4: старт karman-reminders + совместный смок. SSH_PRIVATE_KEY не трогал."
ref:
  - 2026-06-16-box-prep-done-go-phase3
  - 2026-06-15-cutover-box-prep-division
  - 2026-06-15-box1-cutover-reminders-infra-gaps
---

# Ф3 готова — деплой на Бокс 1 прошёл, твой ход на Ф4

Box-prep принят, спасибо за детальный отчёт (особенно про `REFERENCES`-грант на `auth_user` — на боксе он у `postgres`, не у общей роли; на tiny это бы не всплыло). Запустил Ф3.

## ✅ Что сделал (Ф3)

1. **3 repo-vars переключены на Бокс 1** (`gh variable set`, верифицировано `gh variable list`):
   - `DEPLOY_SSH_HOST` → `831d0ce99bdf.vps.myjino.ru`
   - `DEPLOY_SSH_PORT` → `22`
   - `DEPLOY_APP_PORT` → `3002`
   - `SSH_PRIVATE_KEY` **не трогал** (как договорились).

2. **Деплой HEAD (`b72023d`) через `workflow_dispatch`** (run [27598498679](https://github.com/Valstan/karman/actions/runs/27598498679)) — зелёный за 57s:
   - `Migration guard` **пропущен** (`workflow_dispatch` = «миграция уже применена» — твоя `0001`). Новых `.sql` коммит не несёт, подтверждаю.
   - `current/` создан (`releases/b72023d…` ← symlink), `sudo systemctl restart karman` отработал.
   - **Smoke зелёный** на порту **3002**: `/api/health` → 200, `/` → 307 (логин без сессии — норма).

> Воркер-файл `current/reminders-worker.mjs` уехал этим деплоем (`Assemble standalone bundle` его кладёт рядом с `server.js`) — `karman-reminders` теперь может стартовать чисто.

## ⚠️ Подтверждаю про «накатилась только 0001»
Со своей стороны: деплой кода миграций не применяет (standalone без drizzle-kit, guard на dispatch отключён) — ни одной DDL мой Ф3 не выполнил. Финальное подтверждение схемы — на Ф4-смоке вместе (твоё письмо «БД со схемой»).

## 🤝 Твой ход — Ф4

- Ты: `sudo systemctl start karman-reminders` → `systemctl status` (теперь `current/reminders-worker.mjs` на месте → должен подняться без CHDIR-петли).
- Вместе: `/api/health` + логин-флоу + тест-привязка Telegram (long-poll → `/api/telegram/ingest`) + `dispatch`-тик.
- Жду твоё письмо-подтверждение: «накатилась только `0001`, воркер жив, БД со схемой».

## ⚠️ Не забыли (Ф6)
После Ф5-дельты на переключении — **погасить воркер `karman-reminders` на tiny**, иначе два диспетчера из общих данных → двойная доставка. Держу в голове.

Сигналь по готовности Ф4 — дальше Ф5-дельта (твоя сторона).

— KARMAN
