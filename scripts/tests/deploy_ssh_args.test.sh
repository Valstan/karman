#!/usr/bin/env bash
# Харнесс G321: значения деплоя должны доезжать до бокса переменными окружения,
# а не позиционными аргументами `ssh`.
#
# Дефект, который проверяем: `ssh host 'bash -s' ARG…` НЕ передаёт argv. ssh
# склеивает аргументы в одну командную строку, и её разбирает удалённый шелл.
# Пустой аргумент при этом исчезает молча, значение с пробелом разъезжается на
# два, а `$` внутри значения раскрывается на боксе. То есть деплой едет с чужими
# данными либо едет в никуда — и ни то, ни другое не выглядит ошибкой.
#
# Харнесс берёт строку построения команды ИЗ САМОГО workflow: иначе он
# проверял бы сам себя, а не файл, который едет на прод.
#
# Путь к workflow не хардкодим: сценарий сам находит свою папку через
# `dirname -- "$0"` (G552: относительный путь убирает класс, а не чинит симптом).
set -uo pipefail

HERE="$(cd "$(dirname -- "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORKFLOW="$REPO/.github/workflows/deploy-prod.yml"

fail() { echo "deploy_ssh_args.test.sh: FAIL — $*" >&2; exit 1; }
step() { echo "deploy_ssh_args.test.sh: $*"; }

[ -f "$WORKFLOW" ] || fail "не найден workflow: $WORKFLOW"

# ── Строки построения команд — из workflow, а не из харнесса ────────────────
# `tr -d '\r'`: рабочая копия .yml на Windows приезжает с CRLF (core.autocrlf),
# и без этой чистки в команду попадает хвостовой CR — а он ломает её ровно так,
# как ломал бы в CI наcheckout с автопреобразованием. В CI файл приезжает в LF,
# поэтому проверяем именно то, что уедет на раннер.
ship_line="$(grep -E '^[[:space:]]*DEPLOY_SSH_CMD=' "$WORKFLOW" | head -n 1 | tr -d '\r')"
[ -n "$ship_line" ] || fail "в workflow нет строки DEPLOY_SSH_CMD="

smoke_line="$(grep -E '^[[:space:]]*DEPLOY_SMOKE_SSH_CMD=' "$WORKFLOW" | head -n 1 | tr -d '\r')"
[ -n "$smoke_line" ] || fail "в workflow нет строки DEPLOY_SMOKE_SSH_CMD="

# Проба: печатает переменные окружения так, как их увидел бы удалённый bash.
probe='printf "V_SHA=[%s]\nV_BASE=[%s]\nV_SHA256=[%s]\nV_TMPD=[%s]\n" "$SHA" "$BASE" "$SHA256" "$TMPD"'

# ── Сценарий 1: враждебные значения (пробел, `$`, кавычка) ─────────────────
DEPLOY_SHA='sha with space'
DEPLOY_BASE='/base/$HOME dir'
SHA256='abc"quoted'
TMPD='/tmp/tmp.ABC123'

eval "$ship_line"
[ -n "${DEPLOY_SSH_CMD:-}" ] || fail "DEPLOY_SSH_CMD не собрался"

new_out="$(printf '%s\n' "$probe" | bash -c "$DEPLOY_SSH_CMD")"
expected='V_SHA=[sha with space]
V_BASE=[/base/$HOME dir]
V_SHA256=[abc"quoted]
V_TMPD=[/tmp/tmp.ABC123]'
if [ "$new_out" != "$expected" ]; then
  fail "новый способ исказил значения.
получено:
$new_out
ожидалось:
$expected"
fi
step "новый способ: пробел, \$ и кавычка дошли целыми"

# ── Отрицательный контроль: старый способ (argv) рвёт значение пробелом ────
# Проба здесь другая: старый способ передаёт значения ПОЗИЦИОННЫМИ аргументами,
# поэтому смотрим на $1..$4, а не на переменные окружения.
old_probe='printf "P1=[%s]\nP2=[%s]\nP3=[%s]\nP4=[%s]\n" "$1" "$2" "$3" "$4"'
old_out="$(printf '%s\n' "$old_probe" | bash -c 'bash -s sha with space /base' 2>/dev/null || true)"
case "$old_out" in
  *'P1=[sha]'*'P2=[with]'*) step "отрицательный контроль: старый способ разорвал значение пробелом" ;;
  *) fail "старый способ не разорвал значение — харнесс не различает способы.
получено:
$old_out" ;;
esac

# ── Сценарий 2: пустое значение ────────────────────────────────────────────
TMPD=''
eval "$ship_line"
new_empty="$(printf '%s\n' "$probe" | bash -c "$DEPLOY_SSH_CMD")"
case "$new_empty" in
  *'V_TMPD=[]'*) step "новый способ: пустое значение пришло пустым" ;;
  *) fail "пустое значение не дошло: $new_empty" ;;
esac

# Отрицательный контроль: в старом способе пустой аргумент исчезал — $4 не было.
old_empty="$(printf 'printf "V4=[%%s]\\n" "${4-unset}"\n' | bash -c 'bash -s sha base abc' 2>/dev/null || true)"
case "$old_empty" in
  *'V4=[unset]'*) step "отрицательный контроль: старый способ терял пустой аргумент" ;;
  *) fail "старый способ не потерял пустой аргумент — харнесс не различает способы" ;;
esac

# ── Сценарий 3: смоук — та же доставка, одно значение ──────────────────────
APP_PORT='3000'
eval "$smoke_line"
# Проба — переменной, а не прямо в printf: иначе внешний printf съест `%s`.
smoke_probe='printf "PORT=[%s]\n" "$PORT"'
smoke_out="$(printf '%s\n' "$smoke_probe" | bash -c "$DEPLOY_SMOKE_SSH_CMD")"
if [ "$smoke_out" != "PORT=[3000]" ]; then
  fail "порт не дошёл до бокса: $smoke_out"
fi
step "смоук: порт дошёл целым"

echo "deploy_ssh_args.test.sh: OK"
