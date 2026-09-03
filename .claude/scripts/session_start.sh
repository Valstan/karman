#!/usr/bin/env bash
# SessionStart hook (D-066, pool #268): печатает состояние git и handoff при открытии
# сессии, чтобы агент стартовал в контексте без ритуала чтения. Только чтение, без сети:
# синхронизацию с origin делает /start шаг 1, хук её не подменяет.
# Вызов: bash .claude/scripts/session_start.sh   (из .claude/settings.json → hooks.SessionStart)
cd "$(dirname "$0")/../.." || exit 0

echo "=== KARMAN · SessionStart · $(date +%F) ==="
git status -sb 2>/dev/null | head -5
git log --oneline -3 2>/dev/null
echo
echo "--- docs/SESSION_HANDOFF.md (как лежит на диске, до pull) ---"
cat docs/SESSION_HANDOFF.md 2>/dev/null || echo "(handoff не найден)"
echo
echo "--- Дальше: /start (sync → почта brain → отложенное). Канон: AGENTS.md ---"
exit 0
