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
includes: vault.sql (secrets_*/passport_*/auth_oidc_identity/auth_totp/auth_recovery_code/auth_audit/person_profile/documents_*/document_field/document_file/circle*/family_*/hotline_*), media.tar.gz
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
# Учётка — из netrc-файла (как у всех остальных выгрузок ниже), а НЕ через
# --user: пароль в argv виден в `ps` любому пользователю машины (S5).
wd -X MKCOL "${WEBDAV_HOST}${WEBDAV_DIR}/" -o /dev/null || true
echo "backup_vault: выгрузка ${NAME}.tar.gpg на Яндекс.Диск…"
if ! backup_upload_archive "$WORK/${NAME}.tar.gpg" "${WEBDAV_HOST}${WEBDAV_DIR}/${NAME}.tar.gpg" wd "$BACKUP_KEEP_DIR"; then
  die "выгрузка не подтверждена размером (две попытки); локальная копия — ${BACKUP_KEEP_DIR}/${NAME}.tar.gpg"
fi

# Отметка подтверждённой выгрузки — её читает сторож. Дата — по НАЧАЛУ запуска
# (RUN_DATE), а не по моменту записи: запуск в ночь на 1-е — это ночь
# последнего числа, и пульс с подтверждением должны говорить об одном и том же.
printf '%s %s\n' "$STAMP" "$NAME" > "$OK_DIR/backup-ok-$RUN_DATE" \
  || echo "backup_vault: ВНИМАНИЕ — отметку подтверждения записать не удалось" >&2

# --- 6. Ретенция: хранить последние $KEEP ----------------------------------
# PROPFIND глубиной 1 → имена karman-vault-*.tar.gpg; сортируем (в имени
# timestamp), удаляем всё сверх $KEEP старейших.
echo "backup_vault: ретенция (хранить $KEEP)…"
mapfile -t REMOTE < <(
  wd -X PROPFIND -H 'Depth: 1' "${WEBDAV_HOST}${WEBDAV_DIR}/" 2>/dev/null \
    | grep -oE 'karman-vault-[0-9]{8}-[0-9]{6}\.tar\.gpg' | sort -u
)
COUNT=${#REMOTE[@]}
if [ "$COUNT" -eq 0 ]; then
  # PROPFIND не отдал ни одного имени — ретенция вслепую, и её провал не виден.
  # На Диске лежал 41 архив при KEEP=14: молчание стоило места.
  echo "backup_vault: ВНИМАНИЕ — PROPFIND не вернул ни одного архива: ретенция ничего не удалит (проверь доступ к папке)" >&2
elif (( COUNT > KEEP )); then
  DELETE=$(( COUNT - KEEP ))
  for old in "${REMOTE[@]:0:$DELETE}"; do
    echo "backup_vault: удаляю старый бэкап ${old}"
    # Ошибку удаления НЕ глотаем: `|| true` превращал неудачную ретенцию в
    # «всё прошло», и облако копило архивы молча.
    if ! wd -X DELETE "${WEBDAV_HOST}${WEBDAV_DIR}/${old}" -o /dev/null; then
      echo "backup_vault: ВНИМАНИЕ — старый бэкап ${old} НЕ удалён (см. код curl)" >&2
    fi
  done
fi

# --- 7. Уборка старых отметок ------------------------------------------------
# Отметки по дате (2 файла в сутки); без уборки каталог растёт вечно. Стираем
# всё старше 60 дней — с запасом на разбор инцидента постфактум.
find "$OK_DIR" -maxdepth 1 -name 'backup-run-*' -mtime +60 -delete 2>/dev/null || true
find "$OK_DIR" -maxdepth 1 -name 'backup-ok-*' -mtime +60 -delete 2>/dev/null || true

echo "backup_vault: ГОТОВО — ${NAME}.tar.gpg (всего на Диске: ${COUNT}); выгрузка подтверждена размером"
