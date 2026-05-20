#!/usr/bin/env bash
set -euo pipefail

systemctl status certbot.timer --no-pager
systemctl list-timers --all | awk 'NR==1 || /certbot/'

# Limit dry-run execution to avoid hanging automation sessions.
timeout 180 sudo certbot renew --dry-run --nginx
