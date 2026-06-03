#!/usr/bin/env bash
# Деплой KARMAN на сервере (единый Next.js).
set -euo pipefail

PROJECT_ROOT="/home/valstan/karman"
cd "$PROJECT_ROOT"

git pull --ff-only
npm ci
npm run build

# standalone-сборке нужны статика и public рядом с server.js.
rm -rf .next/standalone/.next/static
cp -r .next/static .next/standalone/.next/static
if [ -d public ]; then
  rm -rf .next/standalone/public
  cp -r public .next/standalone/public
fi

# Миграции применяются только если они есть (baseline уже помечен, см. OPERATIONS.md).
if [ -d lib/db/migrations ] && ls lib/db/migrations/*.sql >/dev/null 2>&1; then
  npm run db:migrate
else
  echo "Миграций нет — пропуск db:migrate."
fi

sudo systemctl restart karman
sleep 1
curl -fsS http://127.0.0.1:3000/api/health && echo
echo "Деплой завершён."
