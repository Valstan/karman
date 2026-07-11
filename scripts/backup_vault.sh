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
# Необязательные:
#   BACKUP_MEDIA_ROOT        — каталог сканов (по умолч. /home/valstan/karman/media)
#   BACKUP_WEBDAV_DIR        — папка на Диске (по умолч. /KARMAN-backups)
#   BACKUP_KEEP              — сколько последних бэкапов хранить (по умолч. 14)

set -euo pipefail

MEDIA_ROOT="${BACKUP_MEDIA_ROOT:-/home/valstan/karman/media}"
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

# curl к WebDAV Яндекса. -f — падать на HTTP-ошибке; учётка через --user.
wd() { curl -fsS --user "${YANDEX_WEBDAV_USER}:${YANDEX_WEBDAV_PASSWORD}" "$@"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAMP="$(date -u +%Y%m%d-%H%M%S)"
NAME="karman-vault-${STAMP}"

# --- 1. Дамп vault-таблиц (ТОЛЬКО секреты/2FA/аудит, не вся БД) --------------
# Явный список таблиц — чтобы бэкап был предсказуем и не тащил кредиты/документы.
echo "backup_vault: pg_dump vault-таблиц…"
pg_dump "$DATABASE_URL" --no-owner --no-privileges \
  -t secrets_project -t secrets_item -t secrets_token -t secrets_audit \
  -t secrets_card -t secrets_card_field \
  -t auth_totp -t auth_recovery_code -t auth_audit \
  > "$WORK/vault.sql"

# --- 2. media/ (сканы документов) ------------------------------------------
if [ -d "$MEDIA_ROOT" ]; then
  echo "backup_vault: tar media/…"
  tar -czf "$WORK/media.tar.gz" -C "$(dirname "$MEDIA_ROOT")" "$(basename "$MEDIA_ROOT")"
else
  echo "backup_vault: media-каталог '$MEDIA_ROOT' отсутствует — пропускаю" >&2
  : > "$WORK/media.tar.gz"
fi

# --- 3. Манифест + сборка бандла -------------------------------------------
cat > "$WORK/MANIFEST.txt" <<EOF
KARMAN vault backup
created_utc: ${STAMP}
includes: vault.sql (secrets_*/auth_totp/auth_recovery_code/auth_audit), media.tar.gz
excludes: SECRETS_MASTER_KEY (корень доверия — хранится у владельца отдельно, pool #008)
note: значения секретов в дампе ЗАШИФРОВАНЫ мастер-ключом; этот архив gpg — второй слой.
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
