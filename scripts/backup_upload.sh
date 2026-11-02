#!/usr/bin/env bash
#
# backup_upload.sh — выгрузка архива на WebDAV с повтором и сверкой размера.
#
# Вынесено отдельным файлом НЕ для красоты, а чтобы эту логику можно было
# прогнать без бокса, без БД и без Яндекс.Диска — с подставным `wd`
# (scripts/tests/backup_upload.test.sh, гейт lib/security/backup-upload.test.ts).
#
# До 02.11 этот кусок жил внутри backup_vault.sh под `set -euo pipefail`, и
# сверка размера была НЕДОСТИЖИМА: упавший curl ронял скрипт ДО неё. Ровно тот
# случай, ради которого сверка и написана (обрыв на середине даёт «существующий»
# бэкап вплоть до дня восстановления), и обрывал саму сверку. Итог — 23 ночи
# без архива (09.10 — 31.10) при зелёном стороже.
#
# Файл ИСТОЧНИТСЯ (source), а не запускается: функции вызывают `wd` из
# backup_vault.sh, переданный им по имени.
#
# Смысл различения, которое здесь и есть:
#   - код возврата curl — это мнение клиента («соединение оборвалось»);
#   - размер на Диске — это факт («файл там, и он целый»).
# Они расходятся (01.11 и 02.11: клиент отвалился в 01:53 UTC, сервер дописал
# файл в 02:17 UTC), и побеждает ФАКТ: успешный клиентский код ошибки не
# должен ни ронять скрипт, ни запускать повторную выгрузку 105 МБ.

# Пора ли снимать снимок media/?
#
# Медиа меняются редко (владелец, 02.11: «раз в неделю бывает, не чаще»), а
# снимок — это ~105 МБ и ~1 ч 45 мин выгрузки по каналу, который держится на
# грани. Поэтому снимок снимается раз в BACKUP_MEDIA_INTERVAL_DAYS (7), а дамп
# vault уходит КАЖДУЮ ночь (килобайты, секунды).
#
# Решение принимается по ПОДТВЕРЖДЁННОМУ снимку (backup-media-ok-*): если
# снимок не удался, отметка не обновится — и следующей ночью попытка
# повторится сама. Никакого «календаря», который надо помнить руками.
#
# Побочно в BACKUP_MEDIA_LAST кладётся дата последнего подтверждённого снимка
# (пусто — снимков ещё не было); её потом пишем в манифест, чтобы при
# восстановлении было видно, какой снимок брать.
BACKUP_MEDIA_LAST=""
backup_media_due() {
  local marker_dir="$1" interval_days="$2" now_epoch="${3:-}"
  local newest age_sec
  [ -n "$now_epoch" ] || now_epoch="$(date +%s)"
  newest="$(ls -t "$marker_dir"/backup-media-ok-* 2>/dev/null | head -1 || true)"
  BACKUP_MEDIA_LAST=""
  # Снимков ещё не было — пора снять первый.
  [ -n "$newest" ] || return 0
  BACKUP_MEDIA_LAST="${newest##*-}"
  age_sec=$(( now_epoch - $(date -r "$newest" +%s 2>/dev/null || echo 0) ))
  [ "$(( age_sec / 86400 ))" -ge "$interval_days" ]
}

# Размер файла на удалённой стороне (Content-Length) или пустая строка.
#
# `|| true` внутри скобок — обязателен, а не украшение: при `set -o pipefail`
# (в backup_vault.sh он включён) неудачный HEAD в пайпе делает ВСЮ подстановку
# неуспешной, и `set -e` убивает скрипт ДО того, как он сможет разобрать
# «размер неизвестен». То есть ровно тот отказ, который мы тут чиним, был бы
# воспроизведён на новом месте.
backup_remote_bytes() {
  local url="$1" wd_fn="$2" out=''
  out="$( { "$wd_fn" -I "$url" 2>/dev/null || true; } \
    | tr -d '\r' \
    | awk 'tolower($1) == "content-length:" { print $2 }' \
    | tail -1 )" || out=''
  printf '%s' "$out"
}

# Одна попытка выгрузки: PUT, затем ВСЕГДА сверка размера.
#
# 0 — размер на Диске совпал с локальным (успех; код curl может быть любым);
# 1 — не подтверждено.
backup_upload_once() {
  local file="$1" url="$2" wd_fn="$3"
  local rc=0 remote local_bytes
  local_bytes="$(stat -c %s "$file")"
  "$wd_fn" -T "$file" "$url" || rc=$?
  remote="$(backup_remote_bytes "$url" "$wd_fn")"
  if [ -n "$remote" ] && [ "$remote" = "$local_bytes" ]; then
    echo "backup_vault: выгрузка подтверждена размером (${local_bytes} Б), код curl=$rc"
    return 0
  fi
  echo "backup_vault: выгрузка НЕ подтверждена (код curl=$rc, локально ${local_bytes} Б, на Диске ${remote:-размер неизвестен} Б)" >&2
  return 1
}

# Ждём, пока сервер дописал файл: PUT может оборваться на стороне клиента,
# пока сервер ещё дописывает (наблюдалось 01.11 — 02.11: клиент отвалился за
# 24 минуты до конца записи). Без этого ожидания мы бы считали успешную
# выгрузку проваленной и пошли качать 105 МБ заново.
#
# Возвращает 0, если размер сошёлся.
#
# Если ресурса на Диске НЕТ (HEAD пустой) — ждать бессмысленно: сервер не
# дописывает то, чего не начал. Тогда сразу возвращаем 1 и выходим к повтору.
backup_wait_for_size() {
  local file="$1" url="$2" wd_fn="$3"
  local local_bytes remote waited_sec=0
  local poll_max_sec="${BACKUP_POLL_MAX_SEC:-$(( ${BACKUP_POLL_MAX_MIN:-30} * 60 ))}"
  local poll_step_sec="${BACKUP_POLL_STEP_SEC:-60}"
  local_bytes="$(stat -c %s "$file")"
  while :; do
    remote="$(backup_remote_bytes "$url" "$wd_fn")"
    if [ -n "$remote" ] && [ "$remote" = "$local_bytes" ]; then
      echo "backup_vault: файл дописан сервером и подтверждён размером (${local_bytes} Б) — повтор не нужен"
      return 0
    fi
    [ -n "$remote" ] || return 1
    [ "$waited_sec" -lt "$poll_max_sec" ] || return 1
    sleep "$poll_step_sec"
    waited_sec=$(( waited_sec + poll_step_sec ))
  done
}

# Выгрузка архива: попытка, ожидание дописывания, при неудаче — ОДНА повторная
# попытка. При двух неудачах локальная копия сохраняется (keep_dir), чтобы
# архив не пропал вместе с временным каталогом: сейчас он удаляется trap'ом,
# и обрыв на середине выгрузки уничтожал единственный экземпляр файла.
#
# 0 — выгрузка подтверждена размером; 1 — подтверждения нет (копия сохранена).
backup_upload_archive() {
  local file="$1" url="$2" wd_fn="$3" keep_dir="${4:-$HOME/backups/pending}"
  local name
  name="$(basename "$file")"

  if backup_upload_once "$file" "$url" "$wd_fn"; then
    return 0
  fi

  # Сервер мог ещё дописывать файл — ждём и перепроверяем, прежде чем качать заново.
  if backup_wait_for_size "$file" "$url" "$wd_fn"; then
    return 0
  fi

  echo "backup_vault: выгрузка не подтверждена — повторяю один раз…" >&2
  if backup_upload_once "$file" "$url" "$wd_fn"; then
    return 0
  fi
  if backup_wait_for_size "$file" "$url" "$wd_fn"; then
    return 0
  fi

  mkdir -p "$keep_dir"
  if cp -f "$file" "$keep_dir/$name"; then
    echo "backup_vault: локальная копия сохранена: $keep_dir/$name" >&2
  else
    echo "backup_vault: ВНИМАНИЕ — локальную копию не удалось сохранить в $keep_dir" >&2
  fi
  return 1
}
