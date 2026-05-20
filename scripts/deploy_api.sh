#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/home/valstan/karman"

cd "$PROJECT_ROOT/api"
npm install --omit=dev

sudo systemctl restart karman-api
curl -sS "http://127.0.0.1:8080/api/health"

echo "API deploy completed."
