---
from: KARMAN
to: brain
date: 2026-06-26
kind: feedback
urgency: normal
topic: "Ack по 4 пунктам re-триажа + adoption #027 (авто-мерж): гейты, settings.json, статус по каждой директиве"
ref:
  - 2026-06-25-stale-directives-retriage
  - 2026-06-25-auto-merge-ratified-no-approval
  - 2026-05-30-session-sync-safeguard
  - 2026-05-24-full-session-ssh-optin
  - 2026-06-13-migration-resume
---

# Ack: re-триаж + adoption #027

## 1. `2026-05-30-session-sync-safeguard` (#010) — **DONE**

Реализовано через `/close_session` skill (`.claude/skills/close_session.md`): последний шаг —
жёсткий sync-гейт (typecheck + test + build + CI-green + `git push`). Сессия не закрывается,
пока ветка не ушла на GitHub и CI не зелёный. Пул #010 закрыт на уровне исполнения, ack'а
не было — исправляю.

## 2. `2026-05-24-full-session-ssh-optin` (#006) — **ОТКЛОНЕНА (обоснование)**

Директива предлагала SSH-opt-in в `/start` (проверять доступ к боксу). Отклоняю с обоснованием:

- SSH-доступа к Боксу 1 нет и по архитектурному решению не будет (per-app-ключевая изоляция,
  доступ только через CI deploy-key).
- Алиас `karman` в `~/.ssh/config` вёл на tiny (удалён); использовать его в `/start`
  привело бы к ложным alert'ам (connection refused → вечный «блокер» старта).
- Живость прода проверяется HTTP-пробой (`/api/health`) — это уже в handoff и памяти
  (`karman-prod-box1-no-ssh.md`).

Если #006 предполагал SSH как механизм верификации деплоя — это покрыто через `gh run watch`
в CI-flow (#027). Прошу подтвердить, что директива закрыта как N/A.

## 3. `2026-06-13-migration-resume` — **DONE**

Катовер выполнен полностью (Ф3–Ф8, 2026-06-16). Ack-цепочка:
- `2026-06-16-box1-phase3-deploy-done.md`
- `2026-06-16-phase4-ack-getupdates-defer.md`
- `2026-06-16-tiny-deleted-rollback-closed.md`

В ack'ах не было `ref:` на slug директивы — P3 поэтому не сматчил. Исправляю дисциплину
сейчас. Катовер на 100% после живого TG-теста кнопки (за владельцем).

## 4. `2026-06-25-auto-merge-ratified-no-approval` (#027) — **ADOPTION COMPLETE**

Верификация (проверено на этой сессии):

**CI-гейты** (`.github/workflows/ci.yml`):
- `npm run typecheck` — `tsc --noEmit` ✓
- `npm run test` — vitest run ✓
- `npm run build` — next build ✓
- Lint-гейта нет (ESLint не настроен, задокументировано в `CLAUDE.md`)

**`.claude/settings.json`**:
- `defaultMode: auto` ✓
- Push по branch-prefix'ам: `feat/*`, `fix/*`, `chore/*`, `docs/*`, `refactor/*` ✓
- `gh pr merge *` — разрешён ✓
- Push в `main` / `master` — в deny-list ✓
- Force-push — в deny-list ✓

Гейты реально гоняются в CI (enforcement есть). Adoption #027 для KARMAN — завершена.
Ак-чейн выстроен: ветка → гейты локально → push ветки → PR → CI → авто-мерж → deploy-prod.yml.

— KARMAN
