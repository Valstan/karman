---
description: Открыть сессию разработки KARMAN — подхватить нитку из docs/SESSION_HANDOFF.md и проверить, что всё синхронизировано с GitHub. Триггерится фразами «начни сессию», «открываемся», «что делаем».
argument-hint: (без аргументов)
allowed-tools: Read, Bash, Glob, Grep
---

# /start — открыть сессию разработки KARMAN

Парная команда к [`/close_session`](close_session.md). Подхватывает контекст без пересказа.

## Шаг 1. Синхронизация и контекст (один блок Bash)

```bash
bash scripts/git_sync_check.sh --warn       # предупредит, если что-то не на GitHub
git status --short --branch
git rev-parse --abbrev-ref HEAD
git log --oneline -5
```

Параллельно прочитать `docs/SESSION_HANDOFF.md`.

## Шаг 2. Подсветить нитку

Кратко (3-6 строк):
- **Status / нитка** из handoff.
- **Следующий шаг** — что делаем первым.
- **Синхронизация:** если `git_sync_check.sh` дал предупреждение (несинхронизированная работа,
  origin опережает) — сказать об этом и предложить `git pull` / разобраться **до** новой работы.
- Если на другой машине осталась feature-ветка с открытым PR — напомнить
  `git fetch && git checkout <branch>`.

> Завершать сессию — через `/close_session` (закоммитит+запушит всё, обновит handoff, проверит гейт).
