# Шифрованный offsite-бэкап vault + media/ (vault Ф4)

Скрипт `scripts/backup_vault.sh` делает шифрованный бэкап секретов и сканов
документов и выгружает на Яндекс.Диск. Механизм реализован; **запуск требует
двух вещей от владельца** (см. «Настройка»).

## Что и куда

- **Содержимое:** `pg_dump` vault-таблиц (`secrets_*`, `auth_totp`,
  `auth_recovery_code`, `auth_audit`) + `tar` каталога `media/` (сканы). Кредиты/
  документы/напоминания НЕ входят — только vault + media (охват выбран владельцем).
- **Шифрование:** весь архив шифруется gpg на **публичный ключ владельца** —
  расшифровать сможет только владелец своим приватным ключом.
- **Назначение:** Яндекс.Диск, папка `/KARMAN-backups` (WebDAV).
- **Ретенция:** хранятся последние `BACKUP_KEEP` (по умолчанию 14), старые удаляются.

**Мастер-ключ (`SECRETS_MASTER_KEY`) в бэкап НЕ входит** (корень доверия, pool #008).
Значения секретов в дампе уже зашифрованы им; gpg — второй слой. Дамп без
мастер-ключа секреты не раскрывает — мастер-ключ владелец хранит отдельно.

## Настройка (владелец — один раз)

### 1. Пароль приложения Яндекса (для WebDAV)

Основной пароль при 2FA не подходит — нужен **пароль приложения**:
Яндекс ID → Безопасность → Пароли приложений → создать для «WebDAV».
Затем дописать в `/etc/karman/karman.env` на боксе (значения — не в git):

```
YANDEX_WEBDAV_USER=<логин-яндекса>
YANDEX_WEBDAV_PASSWORD=<пароль-приложения>
```

### 2. Публичный gpg-ключ владельца (для шифрования)

Экспортировать свой публичный ключ и импортировать на боксе:

```bash
# на своей машине:
gpg --export --armor <ваш-ключ> > karman-owner.pub.asc
# скопировать на бокс и импортировать под valstan:
scp karman-owner.pub.asc karman:~/
ssh karman 'gpg --import ~/karman-owner.pub.asc && rm ~/karman-owner.pub.asc'
```

Взять fingerprint (`gpg --list-keys`) и дописать в env:

```
BACKUP_GPG_RECIPIENT=<fingerprint-или-email-ключа>
```

> Если своего gpg-ключа нет — создать: `gpg --full-generate-key` (RSA 4096),
> приватный держать в надёжном месте (без него бэкап не восстановить).

## Ручной запуск (проверка)

```bash
ssh karman 'set -a; . /etc/karman/karman.env; set +a; cd ~/karman && bash scripts/backup_vault.sh'
```

Успех: строка `backup_vault: ГОТОВО — karman-vault-….tar.gpg`. Проверить, что файл
появился на Яндекс.Диске в `/KARMAN-backups`.

## Расписание (после успешной ручной проверки)

Ночной запуск через user-crontab (root не нужен):

```bash
ssh karman 'crontab -l 2>/dev/null; echo "30 3 * * * set -a; . /etc/karman/karman.env; set +a; bash /home/valstan/karman/scripts/backup_vault.sh >> /home/valstan/backups/vault-backup.log 2>&1" | crontab -'
```

(03:30 ежедневно; лог — `~/backups/vault-backup.log`.)

## Восстановление

```bash
# скачать нужный архив с Яндекс.Диска, затем:
gpg --decrypt karman-vault-YYYYMMDD-HHMMSS.tar.gpg > bundle.tar   # приватным ключом владельца
tar -xf bundle.tar                # → MANIFEST.txt, vault.sql, media.tar.gz
# секреты: восстановить таблицы в БД (осторожно на живом проде — #025):
psql "$DATABASE_URL" -f vault.sql
# сканы:
tar -xzf media.tar.gz -C <куда-нужно>
```

Расшифровка значений секретов после восстановления требует того же
`SECRETS_MASTER_KEY`, что был на момент бэкапа (у владельца).

## Слои

`scripts/backup_vault.sh` · env в `/etc/karman/karman.env` (box-side) ·
Яндекс.Диск `/KARMAN-backups`. План — `docs/secrets-vault-plan.md` (Ф4).
