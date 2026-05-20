#!/usr/bin/env bash
set -euo pipefail

sudo systemctl restart karman-api
sudo systemctl status karman-api --no-pager
curl -sS "http://127.0.0.1:8080/api/health"
