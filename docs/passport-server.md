# Паспортный вход в vault (ADR-0012, волна 2)

Проект предъявляет **подписанное удостоверение своего CI** и получает короткоживущий
токен своей комнаты. Общий `VAULT_PROVISION_KEY` перестаёт быть штатным входом и
становится break-glass'ом.

Спека — `../brain_matrica/adr/0012-ecosystem-passport.md`. Здесь — то, что реально
выкачено: контракт роутов, рецепт клиента, runbook владельца и границы.

## Зачем (одной строкой)

Аутентификация «предъяви правильную строку» заменяется на «докажи подписью, кто ты»:
личность берётся из криптографического claim'а, авторизация — **ровно своя комната**,
отзыв — строка в БД, ротация — перезапуск деплоя, аудит впервые отвечает на «кто».

## Контракт

### `POST /api/secrets/session` — открыть сессию

```
Authorization: Bearer <OIDC-JWT, запрошенный с audience karman-vault>
```

| Ответ | Когда |
|---|---|
| `201 {ok, token, tokenPrefix, expiresAt, slug, canWrite, jwksStale}` | удостоверение проверено, личность в реестре |
| `401 {error}` | подпись/срок/ветка/повтор `jti` — снаружи неразличимы, подробность в аудите |
| `403 {error}` | подпись валидна, но личности нет в реестре (комната **не заводится** автоматически) |
| `429 {error}` | лимит по доказанному claim'у |
| `503 {error}` | JWKS issuer'а недоступен и снимка нет вовсе |

`token` — обычный `skm_`-токен своей комнаты **со сроком**: дальше работает штатный
контур `GET/POST /api/secrets`, клиент волны 1 меняется в одной строке — там, где он
берёт токен. `jwksStale: true` означает, что подпись проверена по последнему удачному
снимку ключей (issuer был недоступен) — повод посмотреть на сеть, но не отказ.

### `GET /api/secrets/self` — интроспекция

```
Authorization: Bearer skm_…
→ {slug, projectId, canWrite, identity, expiresAt, createdAt, lastUsedAt}
```

`identity: null` — статический токен комнаты, выданный владельцем (не паспортная сессия).
Отозванный/истёкший токен неотличим от неизвестного: `401`.

### `DELETE /api/secrets/session` — самоотзыв

```
Authorization: Bearer skm_…   → {ok: true}
```

Держатель обязан уметь погасить токен сам: иначе единственный путь отзыва — владелец,
то есть тот самый человек, которого паспорт убирает из штатного контура.

## Что именно проверяется (fail-closed)

`lib/passport/verify.ts` — чистый модуль, приёмка `lib/passport/verify.test.ts`
(4 позитива / 13 негативов). Набор проверок пришёл из адверсариальной проверки
ADR-0012 §5, это не рекомендации:

- **allowlist алгоритма** (`RS*`/`ES*`) и **обязательный `kid`** — HS256 «публичным
  ключом из JWKS» отвергается на заголовке, до проверки подписи;
- `iss`/`aud` — из строки реестра issuer'ов, а не из самого токена;
- **`maxTokenAge` 5 мин** и **`clockTolerance` 30 с** — явно, jose их сам не ставит;
- **пин субъекта** регэкспом issuer'а: `^repo:[^:/]+/[^:/]+:ref:refs/heads/(main|master)$` —
  ветки, PR и форки личность **не минтят**;
- **отказ раннерам вне доверенного окружения** (`runner_environment` ≠ `github-hosted`);
- **обязательный `jti`** + одноразовость: строка `passport_assertion` пишется **только при
  успехе** и в одной транзакции с выдачей токена — иначе ретрай CI ломался бы о собственный
  anti-replay, а выдача без записи открывала бы окно replay;
- **рейт-лимит по доказанному claim'у**, а не по `x-forwarded-for` (его клиент подставляет сам).

Личность привязана к **неизменяемому числовому идентификатору** (`repository_id`), а не к
имени: переименование не создаёт дыру, перехват освободившегося имени не даёт личности.

### JWKS: удалённый фетч + cooldown + stale-if-error

`lib/passport/jwks.ts`. Снимок ключей лежит в БД (`passport_jwks_cache`), обновляется не
чаще раза в 15 минут, таймаут запроса 5 с. Issuer недоступен → работаем на последнем
удачном снимке и пишем `last_error`. Ключей нет вовсе → `503`, а **не** пропуск проверки
подписи. In-memory кеш `createRemoteJWKSet` не подошёл: он не переживает рестарт и падает
вместе с чужим CDN.

Кеш **намеренно не в бэкапе** — восстанавливается фетчем.

## Реестр: две таблицы, обе заполняются явно

- `passport_issuer` — доверенный issuer. GitHub OIDC засеян миграцией `0007`. Строка issuer'а
  **сама по себе доступа не даёт**.
- `passport_identity` — карта личность → комната. **Только руками владельца.** Автозаведение
  комнаты неизвестной личности и автовывод slug'а из имени репо запрещены: вывод не
  инъективен, а в vault уже лежали мусорные комнаты (`rmzmalmyzh`, `provsmoke`).

### Runbook владельца: завести личность

Идентификатор берётся у GitHub, комната — **из живого `/secrets`**, а не из документации.

```bash
# 1. Числовой id репозитория (неизменяемый):
gh api repos/Valstan/trener --jq .id

# 2. id комнаты — из живого vault (страница /secrets или psql):
ssh karman 'set -a; . /etc/karman/karman.env; psql "$DATABASE_URL" -c \
  "select id, slug from secrets_project order by id"'

# 3. Строка реестра (can_write=false — читателю запись не нужна):
ssh karman 'set -a; . /etc/karman/karman.env; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f -' <<SQL
insert into passport_identity (issuer_id, identity_value, label, project_id, can_write, note)
select i.id, '<REPO_ID>', 'Valstan/trener', <PROJECT_ID>, false, 'пилот волны 2'
from passport_issuer i
where i.issuer = 'https://token.actions.githubusercontent.com';
SQL
```

### Runbook владельца: отозвать личность (каскад)

`enabled=false` без каскада — декорация: личность уже выпустила артефакты, и они
переживут отключение. Отзыв гасит строку **и её живые сессии** одной транзакцией:

```sql
begin;
update passport_identity set revoked_at = now() where id = <IDENTITY_ID>;
update secrets_token set revoked_at = now()
 where identity_id = <IDENTITY_ID> and revoked_at is null;
commit;
```

Сверх каскада отзыв проверяется **на каждом чтении**: `pullByToken`/`pushByToken` джойнят
`passport_identity`, поэтому даже забытый второй `update` не оставляет работающих сессий.

## Рецепт клиента (сторона проекта)

Волна 1 у потребителей уже есть; меняется одна строка — откуда берётся токен.

```yaml
permissions:
  id-token: write        # без этого GitHub удостоверение не выдаст
  contents: read
steps:
  - name: Сессия в vault по паспорту
    run: |
      set -euo pipefail
      ASSERTION="$(curl -sf -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
        "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=karman-vault" | jq -r .value)"
      TOKEN="$(curl -sf -X POST https://<karman-host>/api/secrets/session \
        -H "Authorization: Bearer $ASSERTION" | jq -r .token)"
      echo "::add-mask::$TOKEN"
      echo "SECRETS_TOKEN=$TOKEN" >> "$GITHUB_ENV"
```

Дальше — клиент волны 1 без изменений (`GET /api/secrets` с `SECRETS_TOKEN`), включая
его allowlist ключей: **рендерить весь pull запрещено** (ADR-0012 §5, это примитив
инъекции — `NODE_OPTIONS`, `LD_PRELOAD`, `DATABASE_URL`).

Хорошим тоном — `DELETE /api/secrets/session` в конце job'а: сессия и так истечёт, но
самоотзыв делает окно минимальным.

## Границы v1 (решения, а не забывчивость)

- **Машинного grant'а нет и не будет** — вырезан адверсариальной проверкой: цель выбирал
  вызывающий, согласия цели не требовалось, а в связке с шагом доставки это RCE на чужом
  проде. Grant — операция владельца данных под 2FA.
- **Комнату паспорт не заводит.** Неизвестная личность → `403`, и точка.
- **GUI-раздела паспорта пока нет** — реестр ведётся SQL'ом по runbook'у выше
  (следующая веха волны 2).
- **Условие девственной комнаты в `provisionFirstToken` не ослаблено** — снятие
  допускается только при уже существующей строке реестра личностей.

## Env

| Переменная | Смысл |
|---|---|
| `PASSPORT_SESSION_TTL_MINUTES` | срок сессии, по умолчанию 60, зажим 5..720 |
| `PROVISION_KEY_ENABLED` | break-glass-выключатель общего ключа; `false` → `/api/secrets/provision` отвечает 503 |
| `VAULT_PROVISION_KEY` | сам break-glass-ключ (ADR-0010), теперь не штатный вход |

## Схема (миграция `0007_ecosystem_passport.sql`)

`passport_issuer`, `passport_identity`, `passport_jwks_cache`, `passport_assertion`;
`secrets_token` += `expires_at`, `identity_id`; `secrets_audit` += `actor`.

Аддитивно, применяется psql'ом ДО деплоя (migration-guard заблокирует авто-деплой →
`gh workflow run deploy-prod.yml --ref main`). Бэкап (`scripts/backup_vault.sh`) догоняет
схему тем же PR — там же добавлен `secrets_grant`, отстававший с миграции `0006`.

## Аудит: «кто», а не «что предъявили»

Колонка `secrets_audit.actor` (долг ADR-0012 §6) — `owner:<id>` / `passport:<label>` /
`token:<prefix>` / `system`, формат в `lib/secrets/actor.ts`. Заодно закрыт второй половиной
тот же долг: GUI-операции владельца (раскрытие секрета и поля карточки, выпуск и отзыв
токена) раньше **не оставляли в аудите ни строки** — теперь оставляют. Строки старше
миграции `0007` несут `actor = NULL`, что читается как «актор неизвестен», а не «никто».
