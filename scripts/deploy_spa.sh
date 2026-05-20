#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/home/valstan/karman"

"$PROJECT_ROOT/scripts/build_spa.sh"
sudo nginx -t
sudo systemctl reload nginx

echo "SPA deployed via nginx reload."
