#!/usr/bin/env bash
#
# health_watch.sh — сторож прода (R5). Прод жил без наблюдения: единственной
# записью в cron был бэкап, и падение приложения, воркера напоминаний или самого
# бэкапа никем не замечалось. Обнаружилось это буквально: 2026-09-04 воркер
# напоминаний нашли работающим из УДАЛЁННОГО каталога релиза с 30 августа —
# три деплоя прошли мимо него, и ни один сигнал об этом не сообщил.
#
# Что проверяет (четыре независимых признака, каждый — да/нет):
#   1. karman.service            — активен;
#   2. karman-reminders.service  — активен (его деплой раньше не трогал);
#   3. /api/health               — HTTP 200 и тело {"status":"ok"} (роут ходит
#                                  в БД: `SELECT 1`, то есть зелёный ответ
#                                  означает и живой Postgres);
#   4. свежесть бэкапа vault     — успешная запись в логе за последние 36 ч
#                                  (cron бэкапа — ежедневно в 03:30).
#
# Шлёт в Telegram владельцу ТОЛЬКО ПРИ СМЕНЕ СОСТОЯНИЯ: упало → письмо,
# поднялось → письмо. Иначе сторож, срабатывающий каждые 10 минут, за ночь
# превращается в спам, а спам перестают читать — и это ровно тот отказ, от
# которого сторож должен защищать.
#
# Запуск на боксе (env из /etc/karman/karman.env):
#   set -a; . /etc/karman/karman.env; set +a; bash scripts/health_watch.sh
#
# Cron (каждые 10 минут):
#   */10 * * * * set -a; . /etc/karman/karman.env; set +a; bash /home/valstan/karman/scripts/health_watch.sh >> /home/valstan/backups/health-watch.log 2>&1
#
# Требуемые env: DATABASE_URL, TELEGRAM_BOT_TOKEN (штатные, уже есть).
# Необязательные: TELEGRAM_API_BASE (реле; см. G307 — прямой api.telegram.org
# с боксов jino теряет примерно половину SYN), HEALTH_STATE_DIR, HEALTH_BACKUP_LOG.

# ВНИМАНИЕ: намеренно БЕЗ `set -e`. В сторожевом скрипте `-e` — ловушка: первая
# же неуспешная проверка (а неуспех здесь — штатный результат, ради него всё и
# написано) убила бы процесс ДО отправки сигнала, и молчание сторожа выглядело
# бы как «всё хорошо». Ошибки ловятся явно, каждой проверкой отдельно.
set -uo pipefail

STATE_DIR="${HEALTH_STATE_DIR:-$HOME/.karman-health}"
STATE_FILE="$STATE_DIR/last-state"
CHAT_CACHE="$STATE_DIR/chat-id"
BACKUP_LOG="${HEALTH_BACKUP_LOG:-$HOME/backups/vault-backup.log}"
BACKUP_MAX_AGE_H=36

mkdir -p "$STATE_DIR" 2>/dev/null

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(stamp) [health-watch] $*"; }

# --- Порт приложения --------------------------------------------------------
# Порт живёт в systemd-юните, а НЕ в env-файле, поэтому берётся оттуда же.
# Хардкод здесь однажды уже стоил смоуку правильного адреса: он стучался бы не
# в то приложение и молчал бы об этом (см. комментарий про APP_PORT в деплое).
PORT="$(systemctl show karman -p Environment --value 2>/dev/null \
  | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -1)"
PORT="${PORT:-3002}"

# --- Кому слать -------------------------------------------------------------
# chat_id берётся из БД, но КЭШИРУЕТСЯ на диск: сторож обязан достучаться и
# тогда, когда Postgres лежит, — а это как раз тот случай, ради которого он и
# заведён. Пустой кэш при мёртвой БД — единственная дыра, и она закрывается
# первым же успешным прогоном.
resolve_chat() {
  local id=''
  if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
    id="$(psql "$DATABASE_URL" -tAc \
      "SELECT l.chat_id FROM telegram_link l JOIN auth_user u ON u.id = l.user_id
        WHERE l.chat_id IS NOT NULL AND l.is_active AND u.is_superuser
        ORDER BY l.user_id LIMIT 1" 2>/dev/null | tr -d '[:space:]')"
  fi
  if [ -n "$id" ]; then
    printf '%s' "$id" > "$CHAT_CACHE" 2>/dev/null
    printf '%s' "$id"
    return 0
  fi
  [ -r "$CHAT_CACHE" ] && cat "$CHAT_CACHE" && return 0
  return 1
}

# --- Отправка ---------------------------------------------------------------
# G307: api.telegram.org с боксов jino теряет около половины SYN — «таймаут» тут
# не блокировка, а сеть. Поэтому короткий таймаут на попытку и повторы ТОЛЬКО на
# сетевой отказ: повторять отказ Bot API (4xx) бессмысленно, он не рассосётся.
send_telegram() {
  local text="$1" chat api base attempt status
  chat="$CHAT_ID"
  if [ -z "$chat" ]; then
    log "получатель неизвестен: БД недоступна и кэша нет — сигнал не отправлен"
    return 1
  fi
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    log "TELEGRAM_BOT_TOKEN не задан — сигнал не отправлен"
    return 1
  fi
  base="${TELEGRAM_API_BASE:-https://api.telegram.org}"
  base="${base%/}"
  api="$base/bot$TELEGRAM_BOT_TOKEN/sendMessage"
  for attempt in 1 2 3 4 5 6; do
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 \
      --data-urlencode "chat_id=$chat" \
      --data-urlencode "text=$text" \
      "$api" 2>/dev/null)"
    case "$status" in
      200) log "сигнал отправлен (попытка $attempt)"; return 0 ;;
      000) sleep 5 ;;                       # сетевой отказ — повторяем
      *)   log "Bot API ответил $status — не повторяем"; return 1 ;;
    esac
  done
  log "шесть попыток не прошли (сеть) — сигнал не доставлен"
  return 1
}

# --- Прогрев кэша получателя ------------------------------------------------
# Разрешается на КАЖДОМ прогоне, а не только при отправке. Первая редакция звала
# resolve_chat из send_telegram — то есть кэш заполнялся бы первым же сигналом,
# а сигнал шлётся ровно тогда, когда что-то сломалось. При мёртвом Postgres это
# значит «получатель неизвестен» в единственный момент, ради которого сторож и
# написан. Поймано прогоном: после первого запуска кэш оказался пуст.
CHAT_ID="$(resolve_chat)" || CHAT_ID=''
if [ -z "$CHAT_ID" ]; then
  log "ВНИМАНИЕ: получатель не разрешён (БД недоступна и кэша нет) — сигнал уйти не сможет"
fi

# --- Проверки ---------------------------------------------------------------
problems=''
add() { problems="${problems}• $1"$'\n'; }

unit_active() { [ "$(systemctl is-active "$1" 2>/dev/null)" = 'active' ]; }

unit_active karman            || add "karman.service не активен ($(systemctl is-active karman 2>/dev/null))"
unit_active karman-reminders  || add "karman-reminders.service не активен ($(systemctl is-active karman-reminders 2>/dev/null))"

body="$(curl -s --max-time 15 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"
if [ "$code" != '200' ]; then
  add "/api/health отдал $code (ожидалось 200)"
elif ! printf '%s' "$body" | grep -q '"status":"ok"'; then
  # Роут ходит в БД и на её отказе отвечает 500 со status:error — то есть этот
  # признак закрывает и «приложение живо», и «Postgres жив».
  add "/api/health ответил 200, но тело не ok: ${body:0:200}"
fi

if [ -r "$BACKUP_LOG" ]; then
  age_h=$(( ( $(date +%s) - $(date -r "$BACKUP_LOG" +%s 2>/dev/null || echo 0) ) / 3600 ))
  if [ "$age_h" -gt "$BACKUP_MAX_AGE_H" ]; then
    add "бэкап vault не писался $age_h ч (порог $BACKUP_MAX_AGE_H ч, cron — ежедневно 03:30)"
  fi
else
  add "лог бэкапа не найден: $BACKUP_LOG"
fi

# --- Сравнение с прошлым состоянием ----------------------------------------
if [ -n "$problems" ]; then now='bad'; else now='ok'; fi
was='ok'
[ -r "$STATE_FILE" ] && was="$(cat "$STATE_FILE" 2>/dev/null)"
printf '%s' "$now" > "$STATE_FILE" 2>/dev/null

if [ "$now" = 'bad' ] && [ "$was" != 'bad' ]; then
  log "состояние ухудшилось; проблемы:"; printf '%s' "$problems"
  send_telegram "КАРМАН — сторож прода

Что не так:
${problems}
Проверено: $(stamp)"
elif [ "$now" = 'ok' ] && [ "$was" = 'bad' ]; then
  log "состояние восстановилось"
  send_telegram "КАРМАН — сторож прода: всё поднялось.

Проверено: $(stamp)"
elif [ "$now" = 'bad' ]; then
  log "по-прежнему плохо (сигнал уже слали, не повторяем):"; printf '%s' "$problems"
else
  log "порядок (порт $PORT)"
fi

exit 0
