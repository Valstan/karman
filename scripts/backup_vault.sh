#!/usr/bin/env bash
#
# backup_vault.sh — шифрованный offsite-бэкап vault + media/ (vault Ф4,
# план docs/secrets-vault-plan.md, runbook docs/secrets-vault-backup.md).
#
# Что делает: pg_dump vault-таблиц (секреты/2FA/аудит) + tar media/ →
# один архив → gpg-шифрование на ПУБЛИЧНЫЙ ключ владельца → выгрузка на
# Яндекс.Диск по WebDAV → ретенция (хранить последние N).
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

MEDIA_ROOT="${BACKUP_MEDIA_ROOT:?BACKUP_MEDIA_ROOT не задан (каталог сканов; значение — MEDIA_ROOT из systemd-юнита)}"
WEBDAV_DIR="${BACKUP_WEBDAV_DIR:-/KARMAN-backups}"
KEEP="${BACKUP_KEEP:-14}"
WEBDAV_HOST="https://webdav.yandex.ru"

die() { echo "backup_vault: ОШИБКА: $*" >&2; exit 1; }

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
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

# curl к WebDAV Яндекса. -f — падать на HTTP-ошибке.
# Учётка идёт файлом, а НЕ через --user: аргументы командной строки видны в `ps`
# любому пользователю машины, а бокс делится с соседями. Файл лежит в mktemp-каталоге
# под 700 и убирается trap'ом вместе с ним.
NETRC="$WORK/netrc"
( umask 077
  echo "machine webdav.yandex.ru login $YANDEX_WEBDAV_USER password $YANDEX_WEBDAV_PASSWORD" > "$NETRC" )
wd() { curl -fsS --netrc-file "$NETRC" "$@"; }
STAMP="$(date -u +%Y%m%d-%H%M%S)"
NAME="karman-vault-${STAMP}"

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
pg_dump "$DATABASE_URL" --no-owner --no-privileges \
  -t secrets_project -t secrets_item -t secrets_token -t secrets_audit \
  -t secrets_card -t secrets_card_field -t secrets_grant -t secrets_bootstrap \
  -t passport_issuer -t passport_identity -t passport_assertion \
  -t auth_totp -t auth_recovery_code -t auth_audit -t auth_oidc_identity \
  -t person_profile \
  -t documents_documentcategory -t documents_document \
  -t document_field -t document_file \
  -t circle -t circle_member \
  > "$WORK/vault.sql"

# --- 2. media/ (сканы документов) ------------------------------------------
# Считаем файлы ДО упаковки: «ГОТОВО» без числа — это отчёт о том, что скрипт
# отработал, а не о том, что что-то забэкаплено. Пустой каталог при живых
# документах = молчаливая потеря, и увидеть её можно только по счётчику.
MEDIA_FILES=0
if [ -d "$MEDIA_ROOT" ]; then
  MEDIA_FILES=$(find "$MEDIA_ROOT" -type f | wc -l)
  echo "backup_vault: tar media/ (файлов: ${MEDIA_FILES})…"
  tar -czf "$WORK/media.tar.gz" -C "$(dirname "$MEDIA_ROOT")" "$(basename "$MEDIA_ROOT")"
  if [ "$MEDIA_FILES" -eq 0 ]; then
    echo "backup_vault: ВНИМАНИЕ — в '$MEDIA_ROOT' ноль файлов. Это норма, только если сканов нет в БД; иначе приложение пишет их в другой каталог (сверь MEDIA_ROOT в systemd-юните)." >&2
  fi
else
  echo "backup_vault: ВНИМАНИЕ — media-каталог '$MEDIA_ROOT' отсутствует, бэкап сканов ПУСТ" >&2
  : > "$WORK/media.tar.gz"
fi

# --- 3. Манифест + сборка бандла -------------------------------------------
# Манифест несёт ОЖИДАЕМЫЕ величины: при восстановлении сразу видно, совпало ли
# распакованное с тем, что паковали, — без сверки со сторонним источником.
cat > "$WORK/MANIFEST.txt" <<EOF
KARMAN vault backup
created_utc: ${STAMP}
includes: vault.sql (secrets_*/passport_*/auth_oidc_identity/auth_totp/auth_recovery_code/auth_audit/person_profile/documents_*/document_field/document_file/circle*), media.tar.gz
excludes: credits_* (кредиты и платежи — восстановимы из выписок банка)
excludes: SECRETS_MASTER_KEY (корень доверия — хранится у владельца отдельно, pool #008)
excludes: passport_jwks_cache (кеш чужих публичных ключей — восстанавливается фетчем)
media_root: ${MEDIA_ROOT}
media_files: ${MEDIA_FILES}
media_bytes: $(stat -c %s "$WORK/media.tar.gz" 2>/dev/null || echo 0)
vault_sql_bytes: $(stat -c %s "$WORK/vault.sql" 2>/dev/null || echo 0)
note: значения секретов в дампе ЗАШИФРОВАНЫ мастер-ключом; этот архив gpg — второй слой.
note: восстановление проверяется учебным прогоном (docs/secrets-vault-backup.md, «Учебное восстановление»).
EOF
tar -cf "$WORK/${NAME}.tar" -C "$WORK" MANIFEST.txt vault.sql media.tar.gz

# --- 4. gpg-шифрование на публичный ключ владельца --------------------------
echo "backup_vault: gpg-шифрование на ${BACKUP_GPG_RECIPIENT}…"
gpg --batch --yes --trust-model always \
  --encrypt --recipient "$BACKUP_GPG_RECIPIENT" \
  --output "$WORK/${NAME}.tar.gpg" "$WORK/${NAME}.tar"

# --- 5. Выгрузка на Яндекс.Диск (WebDAV) -----------------------------------
# MKCOL создаёт папку (405 = уже есть — не ошибка, поэтому без -f здесь).
curl -sS --user "${YANDEX_WEBDAV_USER}:${YANDEX_WEBDAV_PASSWORD}" \
  -X MKCOL "${WEBDAV_HOST}${WEBDAV_DIR}/" -o /dev/null || true
echo "backup_vault: выгрузка ${NAME}.tar.gpg на Яндекс.Диск…"
wd -T "$WORK/${NAME}.tar.gpg" "${WEBDAV_HOST}${WEBDAV_DIR}/${NAME}.tar.gpg"

# Сверка размера ПОСЛЕ выгрузки: успешный PUT означает «сервер принял запрос»,
# а не «на Диске лежит целый файл». Обрыв на середине даёт ровно тот бэкап,
# который выглядит существующим ровно до дня восстановления.
LOCAL_BYTES=$(stat -c %s "$WORK/${NAME}.tar.gpg")
REMOTE_BYTES=$(wd -I "${WEBDAV_HOST}${WEBDAV_DIR}/${NAME}.tar.gpg" 2>/dev/null \
  | tr -d '\r' | awk 'tolower($1) == "content-length:" { print $2 }' | tail -1)
if [ -z "$REMOTE_BYTES" ]; then
  echo "backup_vault: ВНИМАНИЕ — размер выгруженного файла проверить не удалось (сервер не отдал Content-Length)" >&2
elif [ "$REMOTE_BYTES" != "$LOCAL_BYTES" ]; then
  die "выгрузка неполная: локально ${LOCAL_BYTES} Б, на Диске ${REMOTE_BYTES} Б"
else
  echo "backup_vault: выгрузка сверена — ${LOCAL_BYTES} Б"
fi

# --- 6. Ретенция: хранить последние $KEEP ----------------------------------
# PROPFIND глубиной 1 → имена karman-vault-*.tar.gpg; сортируем (в имени
# timestamp), удаляем всё сверх $KEEP старейших.
echo "backup_vault: ретенция (хранить $KEEP)…"
mapfile -t REMOTE < <(
  wd -X PROPFIND -H 'Depth: 1' "${WEBDAV_HOST}${WEBDAV_DIR}/" 2>/dev/null \
    | grep -oE 'karman-vault-[0-9]{8}-[0-9]{6}\.tar\.gpg' | sort -u
)
COUNT=${#REMOTE[@]}
if (( COUNT > KEEP )); then
  DELETE=$(( COUNT - KEEP ))
  for old in "${REMOTE[@]:0:$DELETE}"; do
    echo "backup_vault: удаляю старый бэкап ${old}"
    wd -X DELETE "${WEBDAV_HOST}${WEBDAV_DIR}/${old}" -o /dev/null || true
  done
fi

echo "backup_vault: ГОТОВО — ${NAME}.tar.gpg (всего на Диске: ${COUNT})"
