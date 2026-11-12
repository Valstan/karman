#!/usr/bin/env bash
# prune_own_class.sh — уборка СВОЕГО класса на боксе (мандат brain 12.11,
# решение владельца 12.11: «чистить своё»).
#
# Что чистим:
#   1. РЕЛИЗНЫЕ АРХИВЫ: оставляем N свежих по mtime, но ЖИВОЙ релиз
#      (на который указывает симлинк `current`) исключаем ВСЕГДА.
#      Почему так: правило «N свежих по mtime» без исключения симлинка
#      сносит живой релиз (G589) — приложение стартует из `current/`.
#      Дополнительно проверяем, что в каталог релиза не указывает
#      WorkingDirectory юнитов и не уехал чей-то cwd (/proc/*/cwd).
#   2. ЛОГИ CRON: у наших логов (health-watch.log, vault-backup.log) нет
#      TTL — они растут вечно. Обрезаем с сохранением хвоста.
#
# Что НЕ трогаем (никогда):
#   - media/ — это документы владельца, не кэш;
#   - чужие каталоги (соседние проекты на общем боксе) — не наш класс;
#   - бэкапы (vault-архивы) — ретенция ими управляется отдельно.
#
# ПОТОЛОК (G589): снос живого релиза = падение прода. Поэтому «current»
# исключается по РАЗРЕШЁННОМУ пути (readlink -f), а не по имени каталога.
#
# ИСПОЛЬЗОВАНИЕ:
#   bash scripts/prune_own_class.sh [--dry-run] [--keep N]
#
# ПО УМОЛЧАНИЮ — dry-run: только показать, что будет удалено. Удаление
# включается флагом --apply (явное намерение оператора).
set -uo pipefail

# Сколько релизов оставляем. Деплой держит 5; чистим до 3 — с запасом
# на откат. Больше не держим: каждый релиз ~61 МБ.
KEEP="${KEEP_RELEASES:-3}"

DRY_RUN=1
# Разбор аргументов — циклом с shift, а не `for arg in "$@"`: в for список
# аргументов раскрывается ОДИН раз, и значение после `--keep N` (N=5) попало бы
# в следующую итерацию как «неизвестный аргумент» → exit 2 → деплой падал бы.
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --apply) DRY_RUN=0 ;;
    --keep)
      shift
      [ $# -gt 0 ] || { echo "prune_own_class.sh: после --keep нужен номер" >&2; exit 2; }
      KEEP="$1"
      ;;
    --keep=*) KEEP="${1#--keep=}" ;;
    *) echo "prune_own_class.sh: неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$KEEP" in
  ''|*[!0-9]*) echo "prune_own_class.sh: --keep должен быть целым числом, а не «$KEEP»" >&2; exit 2 ;;
esac

BASE="${DEPLOY_BASE:-$HOME/karman}"
LOG_DIR="${OWN_LOG_DIR:-$HOME/backups}"

say() { echo "prune_own_class.sh: $*"; }

# ── Занято ли каталог кем-то живым ───────────────────────────────────────────
# Каталог релиза нельзя сносить, если в него указывает WorkingDirectory
# systemd-юнита или чей-то cwd (/proc/<pid>/cwd). Сравниваем РАЗРЕШЁННЫЕ пути:
# grep по симлинкам /proc/*/cwd не работает (это не текстовые файлы).
dir_is_busy() {
  local target="$1" pid link
  for unit in karman karman-reminders; do
    link="$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null || true)"
    if [ -n "$link" ] && [ "$(readlink -f "$link" 2>/dev/null || echo "$link")" = "$target" ]; then
      return 0
    fi
  done
  for pid in /proc/[0-9]*; do
    [ -e "$pid/cwd" ] || continue
    link="$(readlink -f "$pid/cwd" 2>/dev/null || true)"
    if [ -n "$link" ] && [ "$link" = "$target" ]; then
      return 0
    fi
  done
  return 1
}

# ── 1. Живой релиз ───────────────────────────────────────────────────────────
# `current` — симлинк; целевой каталог исключаем из удаления.
live=""
if [ -L "$BASE/current" ]; then
  live="$(readlink -f "$BASE/current" 2>/dev/null || true)"
fi
say "база релизов: $BASE"
say "живой релиз: ${live:-не найден (current — не симлинк)}"

# ── 2. Кандидаты на удаление ─────────────────────────────────────────────────
# Порядок — свежие по mtime первыми; оставляем первые KEEP.
candidates=()
if [ -d "$BASE/releases" ]; then
  while IFS= read -r d; do
    [ -n "$d" ] && candidates+=("$d")
  done < <(ls -1dt "$BASE"/releases/*/ 2>/dev/null)
fi

keep_count=0
for d in "${candidates[@]:-}"; do
  [ -n "$d" ] || continue
  resolved="$(readlink -f "$d" 2>/dev/null || echo "$d")"
  keep_count=$((keep_count + 1))
  if [ "$keep_count" -le "$KEEP" ]; then
    if [ -n "$live" ] && [ "$resolved" = "$live" ]; then
      say "ЖИВОЙ — не трогаю (и в пятёрку входит): $resolved"
    else
      say "оставляю (свежие): $resolved"
    fi
    continue
  fi
  # Живой релиз не сносим НИКОГДА, даже если он старше пятёрки (G589) —
  # из него запущено приложение.
  if [ -n "$live" ] && [ "$resolved" = "$live" ]; then
    say "ЖИВОЙ (старше пятёрки) — не трогаю: $resolved"
    continue
  fi
  # Перестраховка от G589: если на каталог указывает WorkingDirectory юнита
  # или чей-то cwd — не сносим.
  if dir_is_busy "$resolved"; then
    say "занят процессом — не трогаю: $resolved"
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "удалил бы: $resolved"
  else
    rm -rf "$resolved" && say "удалил: $resolved"
  fi
done

# ── 3. Логи cron без TTL ─────────────────────────────────────────────────────
# Обрезаем, сохраняя хвост: лог нужен для разбора, но расти вечно не должен.
LOG_MAX_BYTES="${LOG_MAX_BYTES:-1048576}"
for name in health-watch.log vault-backup.log; do
  f="$LOG_DIR/$name"
  [ -f "$f" ] || continue
  size="$(stat -c %s "$f" 2>/dev/null || echo 0)"
  if [ "$size" -le "$LOG_MAX_BYTES" ]; then
    say "лог в норме ($size Б): $name"
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "обрезал бы лог ($size Б → хвост): $name"
  else
    tail -c "$LOG_MAX_BYTES" "$f" > "$f.trimmed" && mv "$f.trimmed" "$f"
    say "обрезал лог ($size Б → $(stat -c %s "$f" 2>/dev/null || echo 0) Б): $name"
  fi
done

[ "$DRY_RUN" = "1" ] && say "dry-run: ничего не удалено (для удаления — --apply)"
exit 0
