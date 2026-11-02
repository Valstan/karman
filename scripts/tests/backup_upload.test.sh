#!/usr/bin/env bash
#
# backup_upload.test.sh — харнесс для scripts/backup_upload.sh.
#
# Логика выгрузки проверяется БЕЗ бокса, без БД и без Яндекс.Диска: функция
# `wd` (это curl) подменяется на подставную, которая имитирует реальные
# сценарии, и мы смотрим, что делает helper.
#
# Сценарии взяты из боевого разбора 02.11 (docs/notes/backup-outage-2026-11-02.md):
#   ok_but_error    — клиент оборвал соединение, сервер дописал файл целиком
#                     (01.11 / 02.11): успех, и ВАЖНО — без повторной выгрузки
#                     105 МБ;
#   still_writing   — сервер дописывает файл после обрыва клиента: helper
#                     дожидается и подтверждает размер;
#   partial_then_ok — первая выгрузка легла неполной, повтор довёл файл;
#   partial_forever — выгрузка не удалась: helper обязан вернуть неуспех и
#                     оставить локальную копию (иначе архив пропадёт вместе
#                     с временным каталогом).
#
# Гейт: lib/security/backup-upload.test.ts (vitest запускает этот харнесс).
# Нужен bash: в CI — ubuntu-latest, локально на Windows — Git Bash.
#
# Скорость: счётчики вызовов держим в переменных, а не считаем grep'ом по
# логу — на Windows spawn процесса стоит ~0.3 с, и лишние вызовы съедали
# полминуты. Ожидание «сервер дописывает» тоже ускорено (sleep подменён) —
# проверяется логика опроса, а не тайминг.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=../backup_upload.sh
. "$SCRIPT_DIR/../backup_upload.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Файл-«архив»: на бою 105 МБ, здесь килобайт (важен только размер).
SRC="$TMP/karman-vault-test.tar.gpg"
head -c 4096 /dev/zero > "$SRC"
FULL_BYTES="$(stat -c %s "$SRC")"
HALF_BYTES=$(( FULL_BYTES / 2 ))

# Окно ожидания «сервер дописывает». Реальное — 30 минут, шаг 60 с
# (BACKUP_POLL_MAX_MIN / BACKUP_POLL_STEP_SEC); здесь — две итерации без
# ожидания: проверяется логика опроса, а не тайминг.
export BACKUP_POLL_MAX_SEC=2
export BACKUP_POLL_STEP_SEC=1

sleep() { :; }

FAKE_MODE=""
FAKE_PUTS=0
FAKE_HEADS=0
FAKE_COUNT=""

# Подставной curl: -T = PUT (выгрузка), -I = HEAD (сверка размера).
#
# Счётчики вызовов живут в ФАЙЛЕ, а не в переменных: helper зовёт `wd` внутри
# пайпа, а каждая стадия пайпа — подshell, где переменные сбрасываются. Общее
# состояние даёт только файл; читаем его builtin'ом `read` (без spawn — на
# Windows каждый процесс стоит ~0.3 с).
wd() {
  local op="$1"; shift
  if ! read -r FAKE_PUTS FAKE_HEADS < "$FAKE_COUNT"; then
    FAKE_PUTS=0
    FAKE_HEADS=0
  fi
  case "$op" in
    -T)
      FAKE_PUTS=$(( FAKE_PUTS + 1 ))
      printf '%s %s\n' "$FAKE_PUTS" "$FAKE_HEADS" > "$FAKE_COUNT"
      case "$FAKE_MODE" in
        ok_but_error|still_writing) return 56 ;;   # клиент отвалился
        *) return 0 ;;
      esac
      ;;
    -I)
      FAKE_HEADS=$(( FAKE_HEADS + 1 ))
      printf '%s %s\n' "$FAKE_PUTS" "$FAKE_HEADS" > "$FAKE_COUNT"
      case "$FAKE_MODE" in
        ok_but_error)
          printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "$FULL_BYTES" ;;
        still_writing)
          # сервер дописывает: сначала половина, потом целое
          if [ "$FAKE_HEADS" -le 2 ]; then
            printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "$HALF_BYTES"
          else
            printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "$FULL_BYTES"
          fi ;;
        partial_then_ok)
          if [ "$FAKE_PUTS" -ge 2 ]; then
            printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "$FULL_BYTES"
          else
            printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "$HALF_BYTES"
          fi ;;
        partial_forever)
          printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "$HALF_BYTES" ;;
      esac
      ;;
    *) return 0 ;;
  esac
}

FAILED=0
fail() { echo "FAIL: $*"; FAILED=1; }
pass() { echo "ok: $*"; }

# Прогон одного сценария: $1 — режим, $2 — ожидаемый код возврата,
# $3 — ожидаемое число PUT.
run_case() {
  local mode="$1" want_rc="$2" want_puts="$3"
  FAKE_MODE="$mode"
  FAKE_PUTS=0
  FAKE_HEADS=0
  FAKE_COUNT="$TMP/count-$mode"
  : > "$FAKE_COUNT"
  local keep="$TMP/keep-$mode"
  local out rc=0
  out="$(backup_upload_archive "$SRC" "https://example.invalid/karman-vault.tar.gpg" wd "$keep" 2>&1)" \
    || rc=$?
  read -r FAKE_PUTS FAKE_HEADS < "$FAKE_COUNT"
  echo "--- кейс $mode: код=$rc, PUT=$FAKE_PUTS, HEAD=$FAKE_HEADS"
  echo "$out" | sed 's/^/    /'
  if [ "$rc" != "$want_rc" ]; then
    fail "$mode: код возврата $rc, ожидался $want_rc"
  else
    pass "$mode: код возврата $rc"
  fi
  if [ "$FAKE_PUTS" != "$want_puts" ]; then
    fail "$mode: PUT $FAKE_PUTS, ожидалось $want_puts"
  else
    pass "$mode: PUT $FAKE_PUTS"
  fi
  LAST_OUT="$out"
  LAST_KEEP="$keep"
}

# --- 1. Клиент упал, сервер дописал: успех БЕЗ повторной выгрузки ------------
run_case ok_but_error 0 1

# --- 2. Сервер дописывает после обрыва: helper дождался ----------------------
run_case still_writing 0 1
case "$LAST_OUT" in
  *"дописан сервером"*) pass "still_writing: helper дождался дописывания" ;;
  *) fail "still_writing: нет сообщения о дописывании сервером" ;;
esac

# --- 3. Первая выгрузка неполная, повтор довёл -------------------------------
run_case partial_then_ok 0 2

# --- 4. Выгрузка не удалась: неуспех + ЛОКАЛЬНАЯ КОПИЯ ------------------------
run_case partial_forever 1 2
if [ -f "$LAST_KEEP/$(basename "$SRC")" ]; then
  kept_bytes="$(stat -c %s "$LAST_KEEP/$(basename "$SRC")")"
  if [ "$kept_bytes" = "$FULL_BYTES" ]; then
    pass "partial_forever: локальная копия сохранена целиком ($kept_bytes Б)"
  else
    fail "partial_forever: локальная копия $kept_bytes Б вместо $FULL_BYTES Б"
  fi
else
  fail "partial_forever: локальной копии нет — архив пропадёт вместе с WORK"
fi

# --- 5. Политика частоты: снимок media/ раз в неделю -------------------------
# Решение владельца (02.11): «vault каждый день, media/ раз в неделю, не
# проверяя». Политика решает по ПОДТВЕРЖДЁННОМУ снимку: снимков не было → пора;
# последний подтверждён свежее интервала → не пора; старше интервала → пора
# (и повторится сама, если прошлый снимок не доехал).
POLICY_DIR="$TMP/policy"
mkdir -p "$POLICY_DIR"
NOW=1000000000
DAY=86400

# 5a. Снимков ещё не было → пора.
if backup_media_due "$POLICY_DIR" 7 "$NOW"; then
  pass "политика: снимков не было — пора снимать"
else
  fail "политика: снимков не было, но снимок НЕ пора"
fi
if [ -z "$BACKUP_MEDIA_LAST" ]; then
  pass "политика: без снимков BACKUP_MEDIA_LAST пуст"
else
  fail "политика: без снимков BACKUP_MEDIA_LAST='$BACKUP_MEDIA_LAST'"
fi

# 5b. Последний снимок 3 дня назад при интервале 7 → не пора.
touch -d "@$(( NOW - 3 * DAY ))" "$POLICY_DIR/backup-media-ok-20260102"
if backup_media_due "$POLICY_DIR" 7 "$NOW"; then
  fail "политика: снимок 3 дня назад (интервал 7) — пора, а должен ждать"
else
  pass "политика: снимок 3 дня назад — не пора"
fi
if [ "$BACKUP_MEDIA_LAST" = "20260102" ]; then
  pass "политика: BACKUP_MEDIA_LAST = дата последнего снимка"
else
  fail "политика: BACKUP_MEDIA_LAST='$BACKUP_MEDIA_LAST' вместо 20260102"
fi

# 5c. Снимок ровно 7 дней назад при интервале 7 → пора (граница включена).
touch -d "@$(( NOW - 7 * DAY ))" "$POLICY_DIR/backup-media-ok-20260102"
if backup_media_due "$POLICY_DIR" 7 "$NOW"; then
  pass "политика: снимок 7 дней назад (интервал 7) — пора"
else
  fail "политика: снимок 7 дней назад (интервал 7) — не пора, а должна"
fi

# 5d. Снимок 8 дней назад → пора.
touch -d "@$(( NOW - 8 * DAY ))" "$POLICY_DIR/backup-media-ok-20260102"
if backup_media_due "$POLICY_DIR" 7 "$NOW"; then
  pass "политика: снимок 8 дней назад — пора"
else
  fail "политика: снимок 8 дней назад — не пора, а должна"
fi

# 5e. Более длинный интервал — реже (настраивается владельцем).
touch -d "@$(( NOW - 8 * DAY ))" "$POLICY_DIR/backup-media-ok-20260102"
if backup_media_due "$POLICY_DIR" 30 "$NOW"; then
  fail "политика: интервал 30 дней, снимок 8 дней назад — пора, а не должен"
else
  pass "политика: интервал 30 дней — снимок 8 дней назад ждёт"
fi

if [ "$FAILED" != "0" ]; then
  echo "backup_upload.test.sh: ПРОВАЛ"
  exit 1
fi
echo "backup_upload.test.sh: OK — все сценарии выгрузки подтверждены"
exit 0
