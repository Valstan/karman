#!/usr/bin/env bash
# Запуск деплоя KARMAN на проде с локальной машины — единая smoke-гейтнутая команда.
#
# SSH к хосту нестабилен (рвёт соединение во время next build), поэтому деплой
# запускается ОТВЯЗАННО (setsid + nohup-семантика): обрыв ssh не убивает билд.
# Затем скрипт опрашивает лог до строки «Деплой завершён.» (она печатается только
# после успешного curl /api/health внутри deploy.sh — это и есть smoke-гейт).
#
# Использование: bash scripts/deploy_remote.sh
set -euo pipefail

SSH_HOST="karman"
LOG="/tmp/karman_deploy.log"

echo "Запускаю деплой отвязанно на ${SSH_HOST}..."
ssh "$SSH_HOST" "cd karman && setsid bash scripts/deploy.sh >${LOG} 2>&1 </dev/null & echo LAUNCHED:\$!"

# Опрос лога: до 10 минут (60 × 10 с).
for i in $(seq 1 60); do
  sleep 10
  out=$(ssh "$SSH_HOST" "tail -5 ${LOG}" 2>/dev/null || echo "(ssh-обрыв, попробую ещё)")
  echo "--- опрос ${i} ---"
  echo "$out"
  if echo "$out" | grep -q "Деплой завершён."; then
    echo "OK: деплой завершён, health-check пройден."
    exit 0
  fi
  if echo "$out" | grep -qE "^npm ERR|Error:|error Command failed"; then
    echo "FAIL: в логе деплоя ошибка — смотри ${LOG} на хосте." >&2
    exit 1
  fi
done

echo "TIMEOUT: деплой не подтвердился за 10 минут — проверь ${LOG} на хосте вручную." >&2
exit 1
