#!/usr/bin/env bash
# Рендер systemd-юнита из шаблона (scripts/*.service).
#
# ЗАЧЕМ ШАБЛОН, А НЕ ГОТОВЫЙ ФАЙЛ. Раньше юниты лежали в репозитории с боевыми
# значениями и копировались на прод через `cp`. Это давало сразу две беды:
#   1) координаты боевой машины (логин, пути, порт) жили в публичном репозитории — D-038;
#   2) файл молча расходился с продом. Проверено дважды: karman.service разъехался
#      к 2026-08-10 (порт, env-файл, путь к node), а karman-reminders.service — к
#      2026-08-25 в тех же четырёх местах. «Установка по инструкции» из шапки в обоих
#      случаях положила бы прод. У шаблона расходиться нечему: значений в нём нет.
#
# Значения берутся из окружения. Источник истины — repo-vars GitHub (см.
# .github/workflows/deploy-prod.yml) и env-файл сервиса на боксе:
#
#   DEPLOY_USER=$(gh variable get DEPLOY_SSH_USER)
#   APP_BASE=$(gh variable get DEPLOY_BASE)
#   APP_PORT=$(gh variable get DEPLOY_APP_PORT)
#   ENV_FILE=/путь/к/env-файлу      NODE_BIN=/путь/к/node
#
# Применение:
#   DEPLOY_USER=… APP_BASE=… APP_PORT=… ENV_FILE=… NODE_BIN=… \
#     bash scripts/render_unit.sh scripts/karman.service | sudo tee /etc/systemd/system/karman.service
#   sudo systemctl daemon-reload && sudo systemctl restart karman
#
# Приёмка: `systemctl show -p Environment,ExecStart,User <unit>` на боксе обязан
# совпасть с тем, что вы отрендерили. Зелёный daemon-reload этого НЕ доказывает.
set -euo pipefail

TEMPLATE="${1:-}"
[ -n "$TEMPLATE" ] || { echo "usage: render_unit.sh <шаблон .service>" >&2; exit 2; }
[ -f "$TEMPLATE" ] || { echo "нет такого шаблона: $TEMPLATE" >&2; exit 2; }

MISSING=""
for v in DEPLOY_USER APP_BASE APP_PORT ENV_FILE NODE_BIN; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || MISSING="$MISSING $v"
done
if [ -n "$MISSING" ]; then
  echo "не заданы переменные:$MISSING" >&2
  exit 2
fi

sed \
  -e "s|@DEPLOY_USER@|$DEPLOY_USER|g" \
  -e "s|@APP_BASE@|$APP_BASE|g" \
  -e "s|@APP_PORT@|$APP_PORT|g" \
  -e "s|@ENV_FILE@|$ENV_FILE|g" \
  -e "s|@NODE_BIN@|$NODE_BIN|g" \
  "$TEMPLATE" > /tmp/render_unit.$$

# Ни один плейсхолдер не должен пережить рендер — иначе юнит не запустится,
# а systemd скажет об этом невнятно.
if grep -q '@[A-Z_]\+@' /tmp/render_unit.$$; then
  echo "в результате остались неподставленные плейсхолдеры:" >&2
  grep -o '@[A-Z_]\+@' /tmp/render_unit.$$ | sort -u >&2
  rm -f /tmp/render_unit.$$
  exit 1
fi

cat /tmp/render_unit.$$
rm -f /tmp/render_unit.$$
