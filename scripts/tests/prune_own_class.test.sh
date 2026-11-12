#!/usr/bin/env bash
# Гейт для scripts/prune_own_class.sh (мандат brain 12.11, уборка своего класса).
#
# Что проверяем — ровно то, из-за чего чистка опасна:
#   1. ЖИВОЙ релиз (симлинк `current`) не сносится НИКОГДА, даже если он
#      самый свежий или самый старый (G589: правило «N свежих по mtime»
#      без исключения симлинка убивает прода).
#   2. Каталог, занятый процессом (WorkingDirectory юнита / чей-то cwd),
#      тоже не сносится.
#   3. media/ не трогается: это документы владельца, не кэш.
#   4. Умолчание — dry-run: без --apply ничего не удаляется.
#
# Проверка идёт на НАСТОЯЩИХ файлах в mktemp-каталоге: скрипт запускается
# как есть, только с подменёнными путями (DEPLOY_BASE / OWN_LOG_DIR).
set -uo pipefail

HERE="$(cd "$(dirname -- "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SCRIPT="$REPO/scripts/prune_own_class.sh"

fail() { echo "prune_own_class.test.sh: FAIL — $*" >&2; exit 1; }
step() { echo "prune_own_class.test.sh: $*"; }

[ -f "$SCRIPT" ] || fail "не найден скрипт: $SCRIPT"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BASE="$WORK/karman"
LOGS="$WORK/logs"
mkdir -p "$BASE/releases" "$LOGS"

# ── Подготовка: три релиза разного возраста + лог больше лимита ─────────────
old="$BASE/releases/old"; mid="$BASE/releases/mid"; new="$BASE/releases/new"
mkdir -p "$old" "$mid" "$new"
touch -d '2026-01-01 00:00' "$old"
touch -d '2026-06-01 00:00' "$mid"
touch -d '2026-11-01 00:00' "$new"

# Живой релиз — САМЫЙ СТАРЫЙ: худший случай для правила «свежие по mtime».
ln -s "$old" "$BASE/current"

dd if=/dev/zero of="$LOGS/health-watch.log" bs=1024 count=300 2>/dev/null
dd if=/dev/zero of="$LOGS/vault-backup.log" bs=1024 count=10 2>/dev/null

run() {
  DEPLOY_BASE="$BASE" OWN_LOG_DIR="$LOGS" LOG_MAX_BYTES=1024 bash "$SCRIPT" "$@" 2>&1
}

# ── Сценарий 1: dry-run по умолчанию — ничего не удалено ────────────────────
out="$(run)"
[ -d "$old" ] || fail "dry-run удалил живой релиз"
[ -d "$mid" ] || fail "dry-run удалил релиз mid"
[ -d "$new" ] || fail "dry-run удалил релиз new"
step "dry-run: релизы на месте (ожидаемо)"

# ── Сценарий 2: --apply — живой релиз выживает, лишние удаляются ──────────
# KEEP=1: оставляем один свежий (new), mid — кандидат на удаление.
out="$(DEPLOY_BASE="$BASE" OWN_LOG_DIR="$LOGS" LOG_MAX_BYTES=1024 KEEP_RELEASES=1 bash "$SCRIPT" --apply 2>&1)"
[ -d "$old" ] || fail "--apply снёс ЖИВОЙ релиз (current -> $old)"
[ -d "$new" ] || fail "--apply удалил свежий релиз, который должен был остаться"
[ -d "$mid" ] && fail "--apply не удалил лишний релиз mid"
step "--apply: живой релиз выжил, лишний удалён"

# ── Сценарий 3: живой релиз — САМЫЙ СВЕЖИЙ, а удалять надо старый ────────
# KEEP=1: из трёх релизов живой (r3) всегда остаётся, r2 — «свежий» (оставляем),
# r1 — лишний (удаляем).
BASE2="$WORK/karman2"; mkdir -p "$BASE2/releases"
mkdir -p "$BASE2/releases/r1" "$BASE2/releases/r2" "$BASE2/releases/r3"
touch -d '2026-01-01 00:00' "$BASE2/releases/r1"
touch -d '2026-05-01 00:00' "$BASE2/releases/r2"
touch -d '2026-11-01 00:00' "$BASE2/releases/r3"
ln -s "$BASE2/releases/r3" "$BASE2/current"
DEPLOY_BASE="$BASE2" OWN_LOG_DIR="$LOGS" KEEP_RELEASES=1 bash "$SCRIPT" --apply >/dev/null 2>&1
[ -d "$BASE2/releases/r3" ] || fail "--apply снёс живой релиз, когда он самый свежий"
[ -d "$BASE2/releases/r2" ] || fail "--apply удалил релиз, который должен был остаться (KEEP=1)"
[ -d "$BASE2/releases/r1" ] && fail "--apply не удалил лишний старый релиз r1 (KEEP=1)"
step "живой среди самых свежих — тоже выжил, лишний удалён"

# ── Сценарий 4: media не трогается ─────────────────────────────────────────
mkdir -p "$BASE/media/documents/1"
echo "документ владельца" > "$BASE/media/documents/1/file.pdf"
DEPLOY_BASE="$BASE" OWN_LOG_DIR="$LOGS" KEEP_RELEASES=1 bash "$SCRIPT" --apply >/dev/null 2>&1
[ -f "$BASE/media/documents/1/file.pdf" ] || fail "--apply удалил документы владельца (media/)"
step "media/ не тронут"

# ── Сценарий 5: лог обрезан по TTL, а маленький — нет ───────────────────────
size="$(stat -c %s "$LOGS/health-watch.log" 2>/dev/null || echo 0)"
[ "$size" -le 1024 ] || fail "лог не обрезан по TTL ($size Б)"
[ -s "$LOGS/vault-backup.log" ] || fail "лог мал, но обрезан в ноль"
step "логи по TTL: большой обрезан, маленький цел"

# ── Сценарий 6: разбор аргументов ──────────────────────────────────────────
# Дефект, который этот сценарий ловит: `for arg in "$@"` раскрывает список
# ОДИН раз, поэтому значение после `--keep N` (N=5) попадало в следующую
# итерацию как «неизвестный аргумент» → exit 2 → деплой падал бы.
out="$(run --apply --keep 5 2>&1)" || fail "--apply --keep 5 упал: $out"
echo "$out" | grep -q 'неизвестный аргумент' && fail "--keep 5 не разобран: $out"
out="$(run --apply --keep=5 2>&1)" || fail "--apply --keep=5 упал: $out"
# `--keep` без значения — отказ (код 2), а не молчаливое «оставь как было».
if out="$(run --keep 2>&1)"; then
  fail "--keep без значения принят молча: $out"
fi
echo "$out" | grep -q 'после --keep нужен номер' || fail "--keep без значения отверг не тем сообщением: $out"
if out="$(run --apply --keep abc 2>&1)"; then
  fail "--keep abc принят молча: $out"
fi
echo "$out" | grep -q 'целым числом' || fail "--keep abc отверг не тем сообщением: $out"
if out="$(run --unknown-flag 2>&1)"; then
  fail "неизвестный флаг принят молча: $out"
fi
echo "$out" | grep -q 'неизвестный аргумент' || fail "неизвестный флаг отверг не тем сообщением: $out"
step "разбор аргументов: --keep N, --keep=N, мусор отвергнут"

echo "prune_own_class.test.sh: OK — 6 сценариев"
exit 0