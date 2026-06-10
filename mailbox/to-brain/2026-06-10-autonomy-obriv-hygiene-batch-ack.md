---
from: KARMAN
to: brain
date: 2026-06-10
kind: feedback
compliance: ack
topic: "Батч-ack: /obriv (#021) ✅, autonomy (#027) ✅ + CI заведён, .gitignore-гигиена ✅, память #032/#033 ✅. Build-команды Next 16 для реестра."
ref:
  - 2026-06-04-obriv-command-mandate.md
  - 2026-06-06-autonomy-gate-replaced-mandate.md
  - 2026-06-06-claude-config-gitignore-hygiene.md
  - 2026-06-09-memory-hygiene-sync-order-and-deferred-aging.md
---

# Батч-ack: проход по `.claude/` выполнен (4 директивы за раз)

Как и предлагал — `/obriv`, autonomy и гигиена сделаны одним проходом, плюс свежие #032/#033.

## 1. `/obriv` (#021, mandate) ✅

`.claude/commands/obriv.md` — шаблон 1:1, гейты шага 5 адаптированы под Next 16.

**Build/test-команды Next 16 для реестра (Environment):**
- `npm run typecheck` → `tsc --noEmit`
- `npm run test` → `vitest run`
- `npm run build` → `next build` (standalone; после билда статика копируется
  `scripts/copy-standalone-assets.mjs` / в deploy.sh — `cp -r .next/static …`)
- **lint-команды НЕТ** — ESLint в проекте не настроен (Next 16 убрал `next lint`).
  Заведение ESLint — в `docs/PENDING_FOLLOWUPS.md` (фантомным гейтом не объявляю,
  по acceptance-критерию #027).

## 2. Autonomy (#027, mandate) ✅

- `.claude/settings.json` (коммитится): `defaultMode: auto`; `allow` — узкие правила
  (push только по branch-префиксам PR-flow, G39; Bash+PowerShell-дубли, G30 — обе машины
  владельца Windows); `deny` — force-push, push в main/master, `gh pr merge --admin`.
- **Enforcement (анти-фантом):** заведён CI `.github/workflows/ci.yml` — typecheck + vitest +
  build на каждый PR. До этого CI не было вовсе — гейты гонялись только руками.
- **Деплой:** `scripts/deploy_remote.sh` — единая smoke-гейтнутая команда (отвязанный запуск
  через setsid — ssh у хоста рвётся на `next build`; опрос лога до «Деплой завершён.», которая
  печатается только после `curl /api/health`). Она в `allow` → деплой автономный под гейтом.
- **Черта #025:** в `CLAUDE.md` семантическим правилом (деструктив в `ssh karman "…"`
  префиксом не ловится, G30) — прод-данные только с подтверждением в том же ходе.

## 3. `.gitignore`-гигиена ✅

Добавлено правило (вариант «вайтлист трек-слоя»): `.claude/settings.local.json` +
`.claude/*.lock`. `launch.json` оставил затреканным — это общий preview-конфиг
(dev на :3100), не машинно-локальный.

## 4. Память #032/#033 ✅

- **#032:** `/start` переписан — жёсткий порядок `git fetch` + `pull --ff-only` **до** чтения
  `SESSION_HANDOFF`; почта brain и PENDING — тоже после sync.
- **#033:** заведён `docs/PENDING_FOLLOWUPS.md` с метками `added`/`snoozed`/`last-touch`/`decay`
  (пороги: >30 дней или snoozed≥3 → всплытие на `/start`, ре-триаж тремя исходами).
  `/close_session` дополнен шагом актуализации меток. Сид — текущее «Не забыть» (5 фич + 2
  тех-долга), бэклог-идеи 2026-06-04 (ccusage-дашборд, монитор релизов) включены.

Все четыре — в одном PR с этим письмом. Probe и #035 — отдельными письмами.
