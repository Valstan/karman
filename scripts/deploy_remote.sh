#!/usr/bin/env bash
# Деплой KARMAN: триггер CI-artifact-воркфлоу (.github/workflows/deploy-prod.yml)
# и ожидание результата. Сборка идёт в GitHub Actions, на прод уезжает готовый
# standalone-артефакт — on-box `next build` больше не выполняется (мандат brain
# 2026-06-11, подготовка к общему Боксу 1).
#
# Обычно воркфлоу запускается сам на push в main; этот скрипт — для ручного
# повторного деплоя (например, после ручного применения миграций).
#
# Использование: bash scripts/deploy_remote.sh
set -euo pipefail

echo "Запускаю workflow deploy-prod..."
gh workflow run deploy-prod.yml

# gh не возвращает id запущенного run — подождать регистрации и взять свежий.
sleep 5
RUN_ID=$(gh run list --workflow=deploy-prod.yml --limit 1 --json databaseId -q '.[0].databaseId')
echo "Run: ${RUN_ID} — жду завершения..."
gh run watch "$RUN_ID" --exit-status
echo "OK: деплой завершён, smoke в CI пройден."
