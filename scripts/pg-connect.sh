#!/usr/bin/env bash
#
# pg-connect.sh — подключение к PostgreSQL без пароля в argv (S5, аудит #057).
#
# ЗАЧЕМ. `psql "$DATABASE_URL"` и `pg_dump "$DATABASE_URL"` кладут весь DSN —
# вместе с паролем роли — в /proc/<pid>/cmdline, а этот файл читает ЛЮБОЙ
# пользователь машины. Бокс делится с соседями, поэтому «пароль не видно
# соседям» здесь было неправдой: он виден всем, кто умеет читать /proc.
# Для Яндекс.Диска это уже сделано (netrc-файл), для PostgreSQL — нет.
#
# КАК. DSN разбирается ОДИН раз: пароль уходит в .pgpass (chmod 600 — родной
# аналог netrc для libpq), а в argv остаётся тот же URI без пароля. libpq сам
# дочитывает пароль из файла. Проверено на боевой машине: с PGPASSFILE запрос
# отвечает, без него — «no password supplied».
#
# ИСПОЛЬЗОВАНИЕ (в скрипте, который сам уже делает `set -euo pipefail`):
#   . "$(dirname "$0")/pg-connect.sh"
#   pg_setup_pgpass "$WORK"          # создаст $WORK/pgpass, выставит PGPASSFILE
#   pg_dump "$PG_DSN_NOPASS" ...     # пароля в argv уже нет
#
# Это НЕ самостоятельный скрипт: запускать нельзя, только подключать (source).

# pg_url_decode <строка> — раскодировать %XX ровно так же, как это делает libpq
# для userinfo в URI. Свой %-экранированный пароль иначе не сошёлся бы с тем,
# что ждёт сервер.
pg_url_decode() {
  local s="$1" hex dec
  while [[ "$s" =~ %([0-9A-Fa-f]{2}) ]]; do
    hex="${BASH_REMATCH[1]}"
    dec="$(printf "\\x$hex")"
    s="${s/%$hex/$dec}"
  done
  printf '%s' "$s"
}

# pg_setup_pgpass <каталог> — разложить пароль из DATABASE_URL в <каталог>/pgpass
# и выставить PGPASSFILE и PG_DSN_NOPASS (URI без пароля — его можно в argv).
pg_setup_pgpass() {
  local dir="${1:?каталог для pgpass не задан}"
  local url="${DATABASE_URL:-}"
  if [ -z "$url" ]; then
    echo "pg-connect: DATABASE_URL не задан" >&2
    return 1
  fi
  if [[ "$url" != *"://"* ]]; then
    echo "pg-connect: DATABASE_URL — не URI (ожидался postgres://…): пароль в argv спрятать нечем" >&2
    return 1
  fi

  local scheme="${url%%://*}"
  local rest="${url#*://}"
  # userinfo заканчивается ПОСЛЕДНИМ '@' — так же, как разбирает libpq.
  local userinfo="" hostpart="$rest"
  if [[ "$rest" == *@* ]]; then
    userinfo="${rest%@*}"
    hostpart="${rest##*@}"
  fi
  local user="" pass=""
  if [ -n "$userinfo" ]; then
    user="${userinfo%%:*}"
    if [ "$userinfo" != "$user" ]; then
      pass="${userinfo#*:}"
    fi
  fi
  user="$(pg_url_decode "$user")"
  pass="$(pg_url_decode "$pass")"

  if [ -z "$pass" ]; then
    # Пароля в DSN нет — прятать нечего, .pgpass не нужен (пустой файл с
    # паролем сломал бы аутентификацию вместо того, чтобы её не ломать).
    PG_DSN_NOPASS="$url"
    return 0
  fi

  # .pgpass: поля host:port:db:user:password; внутри пароля ':' и '\' экранируются.
  local esc="${pass//\\/\\\\}"
  esc="${esc//:/\\:}"
  printf '*:*:*:*:%s\n' "$esc" > "$dir/pgpass"
  chmod 600 "$dir/pgpass"
  export PGPASSFILE="$dir/pgpass"
  PG_DSN_NOPASS="${scheme}://${user}@${hostpart}"
}
