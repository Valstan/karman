# KARMAN — указания для Claude Code

Учёт кредитов: единое приложение Next.js 16 + TypeScript + Drizzle + Postgres.
Контекст сессий — `docs/SESSION_HANDOFF.md`; отложенное — `docs/PENDING_FOLLOWUPS.md`;
архитектура/операции — `docs/`.

## Гейты качества (предпосылка автономии)

- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `eslint . --max-warnings 0` (flat config `eslint.config.mjs`,
  eslint-config-next 16 на ESLint 9; warnings = провал гейта).
- `npm run test` — `vitest run`
- `npm run build` — `next build`
- CI (`.github/workflows/ci.yml`) гоняет те же гейты на PR.

## Автономия под гейтами (#027)

Внутри PR-flow (не прямой push в main): ветка → правки → локальные гейты →
push ветки → PR → CI зелёный → авто-мерж → деплой запускается **сам** (workflow
`deploy-prod.yml` на push в main: сборка standalone-артефакта в Actions → SSH-доставка →
restart → smoke). Дождаться зелёного run'а (`gh run watch`); ручной перезапуск —
`bash scripts/deploy_remote.sh`. On-box `next build` запрещён (мандат brain 2026-06-11).

## Соседи по экосистеме (ADR-0007 мозга)

Sibling-репо (`../<project>/`) можно читать **read-only напрямую** (перед чтением —
`git pull --ff-only`), без письма мозгу. Писать/коммитить в чужой репо нельзя; «пусть сосед
сделает X» — только через мозг. Если построил ЗАВИСИМОСТЬ от чужого API/формата — письмо мозгу.

## Черта, которую НЕ пересекаем без подтверждения (#025)

Необратимые операции с прод-данными подтверждаются владельцем **в том же ходе**,
где будет выполнена команда: `DROP`/`DELETE`/`UPDATE`/`TRUNCATE` на живой прод-БД,
прод-миграции на живых данных, `rm` прод-путей (`media/`, бэкапы), `systemctl stop`.
Это касается и команд, завёрнутых в `ssh karman "..."` — деструктив внутри кавычек
permissions-префиксом не ловится, поэтому правило семантическое: увидел такую
команду — сначала `AskUserQuestion`. Read-only probe по ssh — можно без вопросов.
