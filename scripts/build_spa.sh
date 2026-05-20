#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/home/valstan/karman"

cd "$PROJECT_ROOT/frontend"
npm install
npm run build

echo "SPA build completed: $PROJECT_ROOT/frontend_dist"
