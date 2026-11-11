#!/usr/bin/env bash
#
# migration_journal.sh — журнал применённых миграций на боевой БД (R1).
#
# ЧТО ДЕЛАЕТ. Читает и дописывает таблицу `schema_migrations` — состояние, а не
# дельту коммита. Именно её спрашивает шаг деплоя: «каждый файл
# lib/db/migrations/*.sql обязан быть в журнале, иначе стоп». Прежний
# предохранитель смотрел на diff последнего коммита и держал ровно один push;
# дыра описана мозгу 28.07 (mailbox/to-brain/2026-07-28-migration-guard-window-
# gotcha.md).
#
# ТРИ РЕЖИМА:
#   list                    — печатает применённые миграции по строке в формате
#                             `version|name` (TSV, разделитель `|`).
#   record <version> <name> — записывает миграцию в журнал (идемпотентно).
#   apply <файл.sql>        — ПРИМЕНЯЕТ миграцию и СРАЗУ записывает её в журнал:
#                             проверить, не применена ли уже; прогнать файл через
#                             psql с ON_ERROR_STOP=1; записать в журнал. Запись —
#                             часть применения, а не отдельный шаг: разорвать их
#                             нельзя, иначе вернётся ровно та дыра, ради которой
#                             всё затевалось.
#
# КОГДА ВЫЗЫВАТЬ:
#   - deploy-prod.yml (шаг гварда): `list` — сверка репозитория с продом;
#   - apply-migration.yml: `apply` — единственный путь применения миграции.
#
# ВЫВОД ИДЁТ В stdout, А НЕ В stderr — СОЗНАТЕЛЬНО. Воркфлоу гонит ssh с
# `2>/dev/null` (G315: stderr ssh печатает хост и порт — координаты боевой
# машины, D-038), поэтому диагностика должна ехать в stdout, иначе оператор
# увидит пустой вывод и не поймёт причину стопа.
#
# КОДЫ ВЫХОДА:
#   0 — успех;
#   2 — журнала нет (таблица не создана) или неверные аргументы. Для вызывающего
#       это однозначный сигнал «сначала применить миграцию 0030».
#
# ПАРОЛЬ РОЛИ — НЕ В argv (S5, аудит #057): пароль уходит в .pgpass внутри
# mktemp-каталога, в argv остаётся URI без пароля (scripts/pg-connect.sh).

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"

# --- Шаблон INSERT'а в журнал ----------------------------------------------
# Гейт lib/db/migration-journal.test.ts вырезает этот блок и выполняет его на
# pglite: продовый SQL проверяется тем же гейтом, а не глазами. Плейсхолдеры
# подставляются одинаково — здесь и в тесте.
# --- RECORD_SQL_BEGIN ---
RECORD_SQL_TEMPLATE="INSERT INTO schema_migrations (version, name) VALUES ('__VERSION__', '__NAME__') ON CONFLICT (version) DO NOTHING;"
# --- RECORD_SQL_END ---

say() { echo "migration_journal: $*"; }
die() { echo "migration_journal: ОШИБКА: $*" >&2; exit 2; }

# --- Подключение ------------------------------------------------------------
# env-файл сервиса: сначала systemd (там он и лежит по факту), потом
# окружение процесса (dev/локальный прогон).
load_env() {
  local env_file=""
  if command -v systemctl >/dev/null 2>&1; then
    env_file="$(systemctl show karman -p EnvironmentFiles --value 2>/dev/null \
      | tr ' ' '\n' | grep -v '^(' | head -1 | sed 's/^-//' || true)"
  fi
  if [ -n "$env_file" ] && [ -r "$env_file" ]; then
    set -a; . "$env_file"; set +a
  fi
  if [ -z "${DATABASE_URL:-}" ]; then
    die "DATABASE_URL не найден: env-файл сервиса не прочитан, и в окружении его нет"
  fi
}

# pg-connect.sh лежит рядом: деплой копирует scripts/*.sh одним набором, а
# боевой канон — каталог из кронтаба. Ищем в трёх местах.
find_pg_connect() {
  local candidates=()
  [ -r "$SCRIPT_DIR/pg-connect.sh" ] && candidates+=("$SCRIPT_DIR/pg-connect.sh")
  local cron_script
  cron_script="$(crontab -l 2>/dev/null | grep -oE '[^ ]*backup_vault\.sh' | head -1 || true)"
  if [ -n "$cron_script" ] && [ -r "$cron_script" ]; then
    candidates+=("$(dirname "$cron_script")/pg-connect.sh")
  fi
  candidates+=("$HOME/karman/scripts/pg-connect.sh")
  local c
  for c in "${candidates[@]}"; do
    if [ -r "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

# Подключается и возвращает DSN без пароля в PG_DSN_NOPASS.
connect() {
  local helper
  helper="$(find_pg_connect)" || die "pg-connect.sh не найден (ищем рядом, в каталоге кронтаба и в \$HOME/karman/scripts) — пароль ушёл бы в argv"
  # shellcheck source=/dev/null
  . "$helper"
  WORK="$(mktemp -d)"
  chmod 700 "$WORK"
  trap 'rm -rf "$WORK"' EXIT
  pg_setup_pgpass "$WORK"
}

# Есть ли таблица журнала.
journal_exists() {
  local out
  out="$(psql "$PG_DSN_NOPASS" -tAc "select to_regclass('public.schema_migrations') is not null" 2>/dev/null || true)"
  [ "$out" = "t" ]
}

cmd_list() {
  load_env
  connect
  if ! journal_exists; then
    say "журнала миграций нет: таблица schema_migrations не создана."
    say "Применить: gh workflow run apply-migration.yml --ref main -f migration=0030_schema_migrations.sql"
    exit 2
  fi
  psql "$PG_DSN_NOPASS" -tA -F'|' -c "select version, name from schema_migrations order by version"
}

cmd_record() {
  local ver="${1:-}"
  local name="${2:-}"
  # Валидация — defense in depth: значения приходят из входа воркфлоу, но и
  # ручной вызов не должен иметь возможности вписать в журнал что угодно.
  printf '%s' "$ver" | grep -qE '^[0-9]{4}$' || die "версия должна быть четырьмя цифрами: '$ver'"
  printf '%s' "$name" | grep -qE '^[0-9]{4}_[a-z0-9_]+\.sql$' || die "имя миграции должно быть вида 0030_schema_migrations.sql: '$name'"
  load_env
  connect
  if ! journal_exists; then
    say "журнала миграций нет: таблица schema_migrations не создана — сначала примените миграцию, создающую журнал."
    exit 2
  fi
  local sql="${RECORD_SQL_TEMPLATE/__VERSION__/$ver}"
  sql="${sql/__NAME__/$name}"
  psql "$PG_DSN_NOPASS" -v ON_ERROR_STOP=1 -c "$sql"
  say "записано: $ver $name"
}

cmd_apply() {
  local file="${1:-}"
  [ -r "$file" ] || die "файл миграции не прочитан: '$file'"
  local name ver
  name="$(basename "$file")"
  ver="${name:0:4}"
  printf '%s' "$ver" | grep -qE '^[0-9]{4}$' || die "имя миграции должно начинаться с четырёх цифр: '$name'"
  printf '%s' "$name" | grep -qE '^[0-9]{4}_[a-z0-9_]+\.sql$' || die "имя миграции должно быть вида 0030_schema_migrations.sql: '$name'"
  load_env
  connect

  if journal_exists; then
    # Повторное применение — стоп. Миграция рассчитана на одну схему, а
    # повтор может либо упасть, либо (на идемпотентном SQL) тихо пройти, и
    # тогда журнал будет врать о том, что миграция применена ровно один раз.
    local applied
    applied="$(psql "$PG_DSN_NOPASS" -tAc "select name from schema_migrations where name = '$name'" 2>/dev/null || true)"
    if [ "$applied" = "$name" ]; then
      say "миграция $name уже записана в журнал — повторное применение остановлено."
      exit 3
    fi
  else
    # Журнала нет — так бывает ровно один раз, на миграции, которая его
    # создаёт. Любая другая миграция в этом состоянии останется незаписанной
    # и упрётся в стоп деплоя, поэтому лучше остановиться здесь, с точным
    # указанием, что применять первым.
    if ! grep -q 'schema_migrations' "$file"; then
      say "журнала миграций нет, а '$name' его не создаёт."
      say "Сначала примените миграцию, создающую журнал (0030_schema_migrations.sql), потом эту."
      exit 2
    fi
    say "журнала ещё нет — применяется миграция, которая его создаёт."
  fi

  psql "$PG_DSN_NOPASS" -v ON_ERROR_STOP=1 -f "$file"
  local sql="${RECORD_SQL_TEMPLATE/__VERSION__/$ver}"
  sql="${sql/__NAME__/$name}"
  psql "$PG_DSN_NOPASS" -v ON_ERROR_STOP=1 -c "$sql"
  say "миграция применена и записана в журнал: $ver $name"
}

case "${1:-}" in
  list) cmd_list ;;
  record) cmd_record "${2:-}" "${3:-}" ;;
  apply) cmd_apply "${2:-}" ;;
  *)
    echo "migration_journal: usage: $0 list | $0 record <version> <name> | $0 apply <файл.sql>" >&2
    exit 2
    ;;
esac
