#!/usr/bin/env bash
#
# backup_vault.sh — шифрованный offsite-бэкап vault + media/ (vault Ф4,
# план docs/secrets-vault-plan.md, runbook docs/secrets-vault-backup.md).
#
# Что делает: pg_dump vault-таблиц (секреты/2FA/аудит) → gpg-шифрование на
# ПУБЛИЧНЫЙ ключ владельца → выгрузка на Яндекс.Диск по WebDAV → ретенция.
#
# ДВА ВИДА АРХИВОВ (решение владельца, 02.11 — «vault каждый день, media/ раз в
# неделю, не проверяя»):
#   karman-vault-YYYYMMDD-HHMMSS.tar.gpg  — ежедневно, только дамп vault
#     (килобайты, секунды): свежесть БД гарантирована каждую ночь;
#   karman-media-YYYYMMDD-HHMMSS.tar.gpg  — раз в BACKUP_MEDIA_INTERVAL_DAYS
#     (7), vault + media/ (снимок сканов, ~105 МБ): медиа меняются редко, а
#     выгрузка 105 МБ по каналу ~17 КБ/с съедает ночное окно целиком.
# Решение о снимке принимается по ПОДТВЕРЖДЁННОМУ снимку: не удался — отметка не
# обновилась, следующая ночь повторит сама.
#
# ВАЖНО: SECRETS_MASTER_KEY в бэкап НЕ входит (корень доверия, pool #008) —
# дамп содержит только ШИФРОТЕКСТ секретов; gpg — второй слой. Восстановление
# без мастер-ключа (хранится у владельца отдельно) секреты не раскроет.
#
# Запуск на боксе (env из /etc/karman/karman.env):
#   set -a; . /etc/karman/karman.env; set +a; bash scripts/backup_vault.sh
#
# Требуемые env (сверх штатных DATABASE_URL):
#   BACKUP_GPG_RECIPIENT     — fingerprint/e-mail публичного gpg-ключа владельца
#                              (ключ импортирован в keyring: gpg --import owner.asc)
#   YANDEX_WEBDAV_USER       — логин Яндекса
#   YANDEX_WEBDAV_PASSWORD   — ПАРОЛЬ ПРИЛОЖЕНИЯ Яндекса (не основной; при 2FA обязателен)
# Обязательные (продолжение):
#   BACKUP_MEDIA_ROOT        — каталог сканов (ОБЯЗАТЕЛЕН; равен MEDIA_ROOT из systemd-юнита)
#   BACKUP_WEBDAV_DIR        — папка на Диске (по умолч. /KARMAN-backups)
#   BACKUP_KEEP              — сколько последних бэкапов хранить (по умолч. 14)

set -euo pipefail

# DSN с паролем роли в argv не кладём (S5, аудит #057): пароль уходит в .pgpass
# (chmod 600), в argv остаётся URI без пароля. Подробности — в pg-connect.sh.
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/pg-connect.sh"

MEDIA_ROOT="${BACKUP_MEDIA_ROOT:?BACKUP_MEDIA_ROOT не задан (каталог сканов; значение — MEDIA_ROOT из systemd-юнита)}"
WEBDAV_DIR="${BACKUP_WEBDAV_DIR:-/KARMAN-backups}"
KEEP="${BACKUP_KEEP:-14}"
WEBDAV_HOST="https://webdav.yandex.ru"

die() { echo "backup_vault: ОШИБКА: $*" >&2; exit 1; }

# Логика выгрузки (повтор + сверка размера, которая не теряется) — отдельным
# файлом, потому что её можно прогнать без бокса и без Диска (гейт
# lib/security/backup-upload.test.ts). Отсутствие помощника — СТОП, а не
# «работаем без сверки»: тихо выгрузить без проверки — ровно тот отказ, который
# стоил 23 ночи.
[ -r "$SCRIPT_DIR/backup_upload.sh" ] \
  || die "помощник выгрузки не найден: $SCRIPT_DIR/backup_upload.sh"
. "$SCRIPT_DIR/backup_upload.sh"

# --- Предусловия ------------------------------------------------------------
: "${DATABASE_URL:?DATABASE_URL не задан (источи /etc/karman/karman.env)}"
: "${BACKUP_GPG_RECIPIENT:?BACKUP_GPG_RECIPIENT не задан (публичный gpg-ключ владельца)}"
: "${YANDEX_WEBDAV_USER:?YANDEX_WEBDAV_USER не задан}"
: "${YANDEX_WEBDAV_PASSWORD:?YANDEX_WEBDAV_PASSWORD не задан (пароль приложения Яндекса)}"
command -v pg_dump >/dev/null || die "pg_dump не найден"
command -v gpg >/dev/null || die "gpg не найден"
command -v curl >/dev/null || die "curl не найден"
gpg --list-keys "$BACKUP_GPG_RECIPIENT" >/dev/null 2>&1 \
  || die "gpg-ключ '$BACKUP_GPG_RECIPIENT' не найден в keyring (gpg --import owner.asc)"

WORK="$(mktemp -d)"
chmod 700 "$WORK"

# --- Отметки о ходе бэкапа ---------------------------------------------------
# Сторож (health_watch.sh) больше не считает «бэкап был» по свежести лога:
# лог писался каждую ночь даже тогда, когда архива на Диске не было
# (09.10 — 31.10 — 23 ночи при зелёном стороже). Признак «бэкап был» =
# подтверждённая выгрузка, то есть совпавший размер.
#
#   backup-run-YYYYMMDD — запуск начался; файл обновляется (пульс) на каждом
#                         этапе, пока идёт выгрузка;
#   backup-ok-YYYYMMDD  — выгрузка подтверждена размером.
#
# Сторож сравнивает пульс с подтверждением: пульс свежий → запуск идёт, тревогу
# не поднимаем; пульс протух, а подтверждения нет → выгрузка не состоялась
# (ровно тот сигнал, которого не было 23 ночи).
OK_DIR="${BACKUP_OK_DIR:-$HOME/.karman-health}"
RUN_DATE="$(date -u +%Y%m%d)"
RUN_MARKER="$OK_DIR/backup-run-$RUN_DATE"
mkdir -p "$OK_DIR"
touch "$RUN_MARKER" 2>/dev/null \
  || echo "backup_vault: ВНИМАНИЕ — отметку запуска создать не удалось ($RUN_MARKER)" >&2

# Пульс во время длинной выгрузки: PUT 105 МБ идёт ~1 ч 45 мин, и без пульса
# сторож счёл бы запуск умершим (а он идёт).
HEARTBEAT_PID=''
heartbeat_start() {
  # `kill -0 $$` — страховка от «вечного» пульса: если скрипт убьют SIGKILL,
  # фоновый цикл должен умереть сам, иначе сторож будет вечно видеть живой
  # запуск и не поднимет тревогу.
  ( while kill -0 "$$" 2>/dev/null; do sleep 60; touch "$RUN_MARKER" 2>/dev/null || true; done ) &
  HEARTBEAT_PID=$!
}
heartbeat_stop() {
  [ -n "$HEARTBEAT_PID" ] && kill "$HEARTBEAT_PID" 2>/dev/null || true
}
trap 'heartbeat_stop; rm -rf "$WORK"' EXIT
heartbeat_start

# Каталог для локальных копий архива, когда выгрузка не подтвердилась: без него
# архив удаляется вместе с WORK, и обрыв на середине уничтожает единственный
# экземпляр файла.
BACKUP_KEEP_DIR="${BACKUP_KEEP_DIR:-$HOME/backups/pending}"

# Пароль роли — в .pgpass внутри WORK (тот же приём, что netrc у Яндекс.Диска):
# argv остаётся чистым, а /proc/<pid>/cmdline не показывает пароль соседям.
pg_setup_pgpass "$WORK"

# curl к WebDAV Яндекса. -f — падать на HTTP-ошибке.
# Учётка идёт файлом, а НЕ через --user: аргументы командной строки видны в `ps`
# любому пользователю машины, а бокс делится с соседями. Файл лежит в mktemp-каталоге
# под 700 и убирается trap'ом вместе с ним.
NETRC="$WORK/netrc"
( umask 077
  echo "machine webdav.yandex.ru login $YANDEX_WEBDAV_USER password $YANDEX_WEBDAV_PASSWORD" > "$NETRC" )
wd() { curl -fsS --netrc-file "$NETRC" "$@"; }
STAMP="$(date -u +%Y%m%d-%H%M%S)"

# --- 1. Дамп невосстановимых таблиц (не вся БД) ------------------------------
# Явный список — чтобы бэкап был предсказуем и не тащил кредиты (их восстановит
# сам владелец из выписок банка).
echo "backup_vault: pg_dump vault-таблиц…"
# Список догоняет схему в том же PR, что и миграция (требование ADR-0012 §5):
# карта личностей и grant'ы — состояние, восстановимое после отката БД только
# руками. secrets_grant отставал от миграции 0006 и добавлен здесь же.
#
# 2026-09-04: добавлены персональные данные и документы. До этого дня скрипт
# сознательно НЕ брал документы — и это было верно ровно пока их было ноль
# строк. С приходом карточек родни (СНИЛС, ИНН, паспорт) сложилось худшее из
# сочетаний: media.tar.gz увозил СКАНЫ, а строки, которые говорят, чей это скан
# и что в документе написано, не увозил никто. Восстановление дало бы папку
# безымянных картинок.
#
# Кредитов здесь по-прежнему нет намеренно: их восстановит банк, а паспорт —
# никто.
#
# 2026-11-03: мультиаккаунт (`accounts_*`) — В бэкапе. Это учётные записи
# владельца от внешних сервисов; пароль в них зашифрован мастер-ключом, а весь
# архив — ещё и gpg-ключом владельца, то есть двойной слой. Исключение было бы
# «тихой потерей»: при смерти бокса список аккаунтов пришлось бы вводить заново
# (а это и почта, и пароль, и то, какой аккаунт на какой проект потрачен).
# У family_* история персональных данных — другое дело, они в дампе (0018).
#
# 2026-10-05: добавлены family_person/family_relation (миграция 0018, древо
# семьи) — четвёртый рецидив класса «таблица вне дампа», найден ре-триажем
# PENDING, а не гейтом. Напоминания (reminder*/telegram_link) сознательно НЕ
# берём: журнал срабатываний — растущий лог воркера, а не состояние; включить
# его — решение владельца отдельным пунктом (запарковано в PENDING).
#
# BACKUP_EXCLUDES — таблицы схемы, сознательно НЕ попадающие в дамп. Формат
# `таблица|причина`, по одной на строку. Не украшение: список читает гейт
# `lib/security/backup-tables.test.ts`, который падает, если в схеме есть
# таблица, не упомянутая ни здесь, ни в `-t` выше. Причина обязательна —
# пустую строку гейт отвергает: «не берём, потому что» и «забыли» должны
# выглядеть в списке по-разному.
BACKUP_EXCLUDES=(
  "auth_user|пароли-хэши (pbkdf2); решение владельца НЕ принято — см. PENDING"
  "credits_bank|восстановится из выписок банка, данных нет ни в чём другом"
  "credits_credit|кредиты восстановит банк; паспорт в бэкапе не восстановить"
  "credits_payment|график платежей восстановится из выписки по кредиту"
  "passport_jwks_cache|кеш чужих публичных ключей, восстанавливается фетчем"
  "telegram_link|привязка чата: восстанавливается заново тем же кодом, состояния нет"
  "reminder|определения напоминаний: решение владельца (в PENDING parked)"
  "reminder_schedule|расписания напоминаний: решение владельца (в PENDING parked)"
  "reminder_delivery|журнал срабатываний — растущий лог воркера, не состояние"
  "reminder_action|нажатия кнопок — то же, что журнал: лог, не состояние"
)

pg_dump "$PG_DSN_NOPASS" --no-owner --no-privileges \
  -t secrets_project -t secrets_item -t secrets_token -t secrets_audit \
  -t secrets_card -t secrets_card_field -t secrets_grant -t secrets_grant_policy \
  -t secrets_bootstrap \
  -t passport_issuer -t passport_identity -t passport_assertion \
  -t auth_totp -t auth_recovery_code -t auth_audit -t auth_oidc_identity \
  -t person_profile \
  -t documents_documentcategory -t documents_document \
  -t document_field -t document_file \
  -t circle -t circle_member \
  -t family_person -t family_relation \
  -t hotline_message -t hotline_presence \
  -t accounts_account -t accounts_project -t accounts_usage \
  > "$WORK/vault.sql"

# --- 2. Частота: снимок media/ — раз в неделю --------------------------------
# Медиа меняются редко (владелец, 02.11: «раз в неделю бывает, не чаще»), а
# снимок media/ — это ~105 МБ и ~1 ч 45 мин выгрузки по каналу ~17 КБ/с: он
# съедает ночное окно почти целиком. Поэтому КАЖДУЮ ночь уходит дамп vault
# (килобайты, секунды), а снимок media/ — раз в BACKUP_MEDIA_INTERVAL_DAYS (7).
#
# Решение принимается по ПОДТВЕРЖДЁННОМУ снимку (backup-media-ok-*): если
# снимок не удался, отметка не обновится — и следующей ночью попытка
# повторится сама (без рук и без «хвоста», который надо помнить).
MEDIA_INTERVAL_DAYS="${BACKUP_MEDIA_INTERVAL_DAYS:-7}"
MEDIA_FILES=0
if [ -d "$MEDIA_ROOT" ]; then
  MEDIA_FILES=$(find "$MEDIA_ROOT" -type f | wc -l)
fi
if backup_media_due "$OK_DIR" "$MEDIA_INTERVAL_DAYS"; then
  TAKE_MEDIA=1
  echo "backup_vault: снимок media/ ПОРА (интервал ${MEDIA_INTERVAL_DAYS} дн, последний подтверждённый: ${BACKUP_MEDIA_LAST:-не было})"
else
  TAKE_MEDIA=0
  echo "backup_vault: снимок media/ не пора (интервал ${MEDIA_INTERVAL_DAYS} дн, последний подтверждённый: ${BACKUP_MEDIA_LAST:-не было}) — грузим только дамп vault"
fi

# --- 3. media/ (сканы документов) — только в недельном снимке ---------------
# Считаем файлы ДО упаковки: «ГОТОВО» без числа — это отчёт о том, что скрипт
# отработал, а не о том, что что-то забэкаплено. Пустой каталог при живых
# документах = молчаливая потеря, и увидеть её можно только по счётчику.
if [ "$TAKE_MEDIA" -eq 1 ]; then
  echo "backup_vault: tar media/ (файлов: ${MEDIA_FILES})…"
  if [ -d "$MEDIA_ROOT" ]; then
    tar -czf "$WORK/media.tar.gz" -C "$(dirname "$MEDIA_ROOT")" "$(basename "$MEDIA_ROOT")"
    if [ "$MEDIA_FILES" -eq 0 ]; then
      echo "backup_vault: ВНИМАНИЕ — в '$MEDIA_ROOT' ноль файлов. Это норма, только если сканов нет в БД; иначе приложение пишет их в другой каталог (сверь MEDIA_ROOT в systemd-юните)." >&2
    fi
  else
    echo "backup_vault: ВНИМАНИЕ — media-каталог '$MEDIA_ROOT' отсутствует, снимок сканов ПУСТ" >&2
    : > "$WORK/media.tar.gz"
  fi
fi

# --- 4. Манифест -------------------------------------------------------------
# Манифест несёт ОЖИДАЕМЫЕ величины: при восстановлении сразу видно, совпало ли
# распакованное с тем, что паковали, — без сверки со сторонним источником.
# У ежедневного бандла media_included=no: он честно говорит, что сканов в нём
# нет, и называет дату последнего подтверждённого снимка (восстановление берёт
# снимок оттуда).
write_manifest() {
  local kind="$1" media_included="$2" media_bytes="$3" last_confirmed="$4"
  cat > "$WORK/MANIFEST.txt" <<EOF
KARMAN vault backup
created_utc: ${STAMP}
kind: ${kind}
includes: vault.sql (secrets_*/passport_*/auth_oidc_identity/auth_totp/auth_recovery_code/auth_audit/person_profile/documents_*/document_field/document_file/circle*/family_*/hotline_*), media.tar.gz
excludes: credits_* (кредиты и платежи — восстановимы из выписок банка)
excludes: SECRETS_MASTER_KEY (корень доверия — хранится у владельца отдельно, pool #008)
excludes: passport_jwks_cache (кеш чужих публичных ключей — восстанавливается фетчем)
media_root: ${MEDIA_ROOT}
media_files_on_disk: ${MEDIA_FILES}
media_included: ${media_included}
media_bytes: ${media_bytes}
media_last_confirmed: ${last_confirmed}
vault_sql_bytes: $(stat -c %s "$WORK/vault.sql" 2>/dev/null || echo 0)
note: значения секретов в дампе ЗАШИФРОВАНЫ мастер-ключом; этот архив gpg — второй слой.
note: восстановление проверяется учебным прогоном (docs/secrets-vault-backup.md, «Учебное восстановление»).
EOF
}

# --- 5. Ежедневный бандл: только vault ---------------------------------------
# Килобайты и секунды — этот архив уходит КАЖДУЮ ночь и гарантирует свежесть
# дампа, даже если недельный снимок media/ не доедет.
DAILY_NAME="karman-vault-${STAMP}"
write_manifest "vault (ежедневно)" "no" 0 "${BACKUP_MEDIA_LAST:-нет подтверждённых снимков}"
tar -cf "$WORK/${DAILY_NAME}.tar" -C "$WORK" MANIFEST.txt vault.sql
echo "backup_vault: gpg-шифрование на ${BACKUP_GPG_RECIPIENT}…"
gpg --batch --yes --trust-model always \
  --encrypt --recipient "$BACKUP_GPG_RECIPIENT" \
  --output "$WORK/${DAILY_NAME}.tar.gpg" "$WORK/${DAILY_NAME}.tar"

# --- 6. Выгрузка на Яндекс.Диск (WebDAV) -----------------------------------
# MKCOL создаёт папку (405 = уже есть — не ошибка, поэтому без -f здесь).
# Учётка — из netrc-файла (как у всех остальных выгрузок ниже), а НЕ через
# --user: пароль в argv виден в `ps` любому пользователю машины (S5).
wd -X MKCOL "${WEBDAV_HOST}${WEBDAV_DIR}/" -o /dev/null || true
echo "backup_vault: выгрузка ${DAILY_NAME}.tar.gpg на Яндекс.Диск…"
if ! backup_upload_archive "$WORK/${DAILY_NAME}.tar.gpg" "${WEBDAV_HOST}${WEBDAV_DIR}/${DAILY_NAME}.tar.gpg" wd "$BACKUP_KEEP_DIR"; then
  die "выгрузка не подтверждена размером (две попытки); локальная копия — ${BACKUP_KEEP_DIR}/${DAILY_NAME}.tar.gpg"
fi

# Отметка подтверждённой выгрузки — её читает сторож. Дата — по НАЧАЛУ запуска
# (RUN_DATE), а не по моменту записи: запуск в ночь на 1-е — это ночь
# последнего числа, и пульс с подтверждением должны говорить об одном и том же.
printf '%s %s\n' "$STAMP" "$DAILY_NAME" > "$OK_DIR/backup-ok-$RUN_DATE" \
  || echo "backup_vault: ВНИМАНИЕ — отметку подтверждения записать не удалось" >&2

# --- 7. Недельный снимок: vault + media -------------------------------------
# Идёт ПОСЛЕ ежедневного: если эта выгрузка упадёт (она идёт ~1 ч 45 мин), свежесть
# дампа за эту ночь уже обеспечена предыдущим шагом. Отметка попытки пишется ДО
# выгрузки — сторож увидит «снимок начат, но не подтверждён» и поднимет тревогу
# сразу, а не через неделю.
if [ "$TAKE_MEDIA" -eq 1 ]; then
  MEDIA_NAME="karman-media-${STAMP}"
  write_manifest "vault + media (недельный снимок)" "yes" "$(stat -c %s "$WORK/media.tar.gz" 2>/dev/null || echo 0)" "этот архив (подтвердится после выгрузки)"
  tar -cf "$WORK/${MEDIA_NAME}.tar" -C "$WORK" MANIFEST.txt vault.sql media.tar.gz
  echo "backup_vault: gpg-шифрование на ${BACKUP_GPG_RECIPIENT}…"
  gpg --batch --yes --trust-model always \
    --encrypt --recipient "$BACKUP_GPG_RECIPIENT" \
    --output "$WORK/${MEDIA_NAME}.tar.gpg" "$WORK/${MEDIA_NAME}.tar"
  printf '%s %s\n' "$STAMP" "$MEDIA_NAME" > "$OK_DIR/backup-media-run-$RUN_DATE" \
    || echo "backup_vault: ВНИМАНИЕ — отметку попытки снимка записать не удалось" >&2
  echo "backup_vault: выгрузка ${MEDIA_NAME}.tar.gpg на Яндекс.Диск…"
  if ! backup_upload_archive "$WORK/${MEDIA_NAME}.tar.gpg" "${WEBDAV_HOST}${WEBDAV_DIR}/${MEDIA_NAME}.tar.gpg" wd "$BACKUP_KEEP_DIR"; then
    die "снимок media/ не подтверждён размером (две попытки); локальная копия — ${BACKUP_KEEP_DIR}/${MEDIA_NAME}.tar.gpg"
  fi
  printf '%s %s\n' "$STAMP" "$MEDIA_NAME" > "$OK_DIR/backup-media-ok-$RUN_DATE" \
    || echo "backup_vault: ВНИМАНИЕ — отметку подтверждения снимка записать не удалось" >&2
fi

# --- 8. Ретенция: vault — последние $KEEP, media — последние $MEDIA_KEEP ----
# PROPFIND глубиной 1 → имена karman-vault-*.tar.gpg и karman-media-*.tar.gpg.
# Два вида архивов считаются ОТДЕЛЬНО: иначе ежедневные (килобайты) вытеснили бы
# недельные (105 МБ), и медиа-снимки перестали бы копиться вовсе.
# Шаблоны непересекающиеся: после «karman-vault-» у ежедневных сразу цифры
# даты, у media — слово «media».
MEDIA_KEEP="${BACKUP_MEDIA_KEEP:-4}"
echo "backup_vault: ретенция (vault: $KEEP, media: $MEDIA_KEEP)…"
PROPFIND_OUT="$(wd -X PROPFIND -H 'Depth: 1' "${WEBDAV_HOST}${WEBDAV_DIR}/" 2>/dev/null || true)"
mapfile -t REMOTE_VAULT < <(
  printf '%s' "$PROPFIND_OUT" | grep -oE 'karman-vault-[0-9]{8}-[0-9]{6}\.tar\.gpg' | sort -u
)
mapfile -t REMOTE_MEDIA < <(
  printf '%s' "$PROPFIND_OUT" | grep -oE 'karman-media-[0-9]{8}-[0-9]{6}\.tar\.gpg' | sort -u
)
COUNT=${#REMOTE_VAULT[@]}
MEDIA_COUNT=${#REMOTE_MEDIA[@]}
retention_pass() {
  local keep="$1" label="$2"; shift 2
  local count=$# old
  if [ "$count" -eq 0 ]; then
    echo "backup_vault: ${label}: архивов не найдено — ретенция ничего не удалит (проверь доступ к папке)" >&2
    return 0
  fi
  if (( count > keep )); then
    # Удаляем ТОЛЬКО срез «сверх keep, самые старые первыми» (backup_retention_delete_list).
    # Цикл по всему списку удалял ВСЁ, включая только что залитый архив: бэкап
    # отчитывался «ГОТОВО» и тут же исчезал с Диска (боевой прогон 03.11,
    # run 41525150902).
    while IFS= read -r old; do
      [ -z "$old" ] && continue
      echo "backup_vault: удаляю старый ${label} ${old}"
      # Ошибку удаления НЕ глотаем: `|| true` превращал неудачную ретенцию в
      # «всё прошло», и облако копило архивы молча.
      if ! wd -X DELETE "${WEBDAV_HOST}${WEBDAV_DIR}/${old}" -o /dev/null; then
        echo "backup_vault: ВНИМАНИЕ — старый ${label} ${old} НЕ удалён (см. код curl)" >&2
      fi
    done < <(backup_retention_delete_list "$keep" "$@")
  fi
}
if [ "${#REMOTE_VAULT[@]}" -gt 0 ]; then
  retention_pass "$KEEP" "бэкап vault" "${REMOTE_VAULT[@]}"
else
  echo "backup_vault: бэкап vault: архивов не найдено — ретенция ничего не удалит (проверь доступ к папке)" >&2
fi
if [ "${#REMOTE_MEDIA[@]}" -gt 0 ]; then
  retention_pass "$MEDIA_KEEP" "снимок media" "${REMOTE_MEDIA[@]}"
else
  echo "backup_vault: снимок media: архивов не найдено — ретенция ничего не удалит (проверь доступ к папке)" >&2
fi

# --- 9. Уборка старых отметок ------------------------------------------------
# Отметки по дате (несколько файлов в сутки); без уборки каталог растёт вечно.
# Стираем всё старше 60 дней — с запасом на разбор инцидента постфактум.
find "$OK_DIR" -maxdepth 1 -name 'backup-run-*' -mtime +60 -delete 2>/dev/null || true
find "$OK_DIR" -maxdepth 1 -name 'backup-ok-*' -mtime +60 -delete 2>/dev/null || true
find "$OK_DIR" -maxdepth 1 -name 'backup-media-run-*' -mtime +60 -delete 2>/dev/null || true
find "$OK_DIR" -maxdepth 1 -name 'backup-media-ok-*' -mtime +60 -delete 2>/dev/null || true

if [ "$TAKE_MEDIA" -eq 1 ]; then
  echo "backup_vault: ГОТОВО — ${DAILY_NAME}.tar.gpg (vault на Диске: ${COUNT}) + ${MEDIA_NAME}.tar.gpg (снимков media: ${MEDIA_COUNT}); выгрузка подтверждена размером"
else
  echo "backup_vault: ГОТОВО — ${DAILY_NAME}.tar.gpg (vault на Диске: ${COUNT}; снимок media не пора — следующий по расписанию); выгрузка подтверждена размером"
fi
