# Access self-serve: runbook live-включения (S1+S2, D-119)

Операционный порядок для слайса 5 мандата S1+S2: миграция `0023`, живой
карман relay, первая политика приёма и первый авто-принятый grant. Каждый
шаг самодостаточен; после шага 3 relay работает без env-секрета (только
vault), env остаётся фолбэком и гасится позже.

Перед выполнением шагов 2–6 нужны права владельца: они пишут в живой прод
(БД, env бокса, рестарт сервиса). Миграция применяется вручную —
`migration-guard` в `deploy-prod.yml` блокирует авто-деплой, пока в диффе
есть новые файлы миграций.

## 1. Миграция 0023 на прод

```bash
psql "$DATABASE_URL" -f lib/db/migrations/0023_grant_policy.sql
```

Проверка: `secrets_grant_policy` существует, частичный уникальный индекс
`secrets_grant_policy_live_uq` на месте (`\d secrets_grant_policy`).

После — деплой workflow_dispatch (`deploy-prod.yml`), дождаться зелёного
(smoke включён).

## 2. Живой карман relay: комната `karman-hotline`

Токен relay-секрета утерян (S1) — перевыпускаем:

```bash
# комната (если ещё нет) — provisioning-ключом:
curl -sf -X POST "$VAULT_URL/api/secrets/provision" \
  -H "Authorization: Bearer $VAULT_PROVISION_KEY" -H "Content-Type: application/json" \
  --data-binary '{"slug":"karman-hotline"}'
# → {"ok":true,"projectId":N,"slug":"karman-hotline","token":"skm_…"}
# (в ответе — НОВЫЙ токен; запомнить, он больше не покажется)
```

Свежее значение relay-секрета (сгенерировать `openssl rand -hex 32`)
кладём в комнату rw-токеном комнаты:

```bash
curl -sf -X POST "$VAULT_URL/api/secrets" \
  -H "Authorization: Bearer <токен karman-hotline>" -H "Content-Type: application/json" \
  --data-binary '{"secrets":{"HOTLINE_RELAY_SECRET":"<новое-значение>"}}'
# smoke с перечнем ожидаемого (G331): 200 только если ключ на месте
curl -sf "$VAULT_URL/api/secrets?key=HOTLINE_RELAY_SECRET" \
  -H "Authorization: Bearer <токен karman-hotline>"
```

## 3. Env бокса: vault-first резолвер

В env-файл сервиса (где лежат остальные env):

```
VAULT_URL=http://127.0.0.1:<APP_PORT>
SECRETS_TOKEN=<rw-токен karman-hotline>
```

`HOTLINE_RELAY_SECRET` в env **оставить как фолбэк** (сейчас он утерян —
можно не восстанавливать вовсе: резолвер vault-first, fail-closed 503
сохранён). Рестарт сервиса. Проверка: `/api/hotline` под новым секретом
отвечает не 503; старый Bearer — 401.

Гашение фолбэка (можно позже, отдельным ходом): убрать
`HOTLINE_RELAY_SECRET` из env, рестарт — relay должен продолжать работать
(секрет восстановлен из vault при первом обращении).

## 4. Ротация перекрытием «выпусти → проверь → отзови старый»

Для relay-секрета (и любого сервисного):

1. **Выпусти**: новое значение в комнату (upsert `POST /api/secrets`).
2. **Подхвати**: у КАРМАНа — кэш TTL 10 мин (или рестарт), у внешних
   бэкендов — их интервал перечитывания (у `karman-tg` — свой).
3. **Проверь**: relay принимает новый Bearer.
4. **Отзови старый**: старое значение никем не хранится после подхвата —
   «отзыв» здесь = значение больше не существует нигде, кроме
   ротировавшего. Гранты не трогаем: комната и ключ те же.

## 5. Первая политика и первый авто-принятый grant (демо S2)

Комната-получатель (любая, например `karman` под собственной
политикой или комната соседа) объявляет согласие своим токеном:

```bash
curl -sf -X POST "$VAULT_URL/api/secrets/policies" \
  -H "Authorization: Bearer <токен-получателя>" -H "Content-Type: application/json" \
  --data-binary '{"source_slug":"karman-hotline","source_key":"HOTLINE_RELAY_SECRET","note":"D-119, live"}'
# → 201 {"ok":true,"id":1,"autoAccept":true}
```

Источник предлагает выдачу — и она принимается СРАЗУ:

```bash
curl -sf -X POST "$VAULT_URL/api/secrets/grants" \
  -H "Authorization: Bearer <токен karman-hotline>" -H "Content-Type: application/json" \
  --data-binary '{"key":"HOTLINE_RELAY_SECRET","target_slug":"<получатель>","note":"D-119, первый auto-accept"}'
# → 201 {"ok":true,"id":N,"state":"active"}   — не "pending"

# проверка: ключ читается получателем своим токеном
curl -sf "$VAULT_URL/api/secrets?key=HOTLINE_RELAY_SECRET" \
  -H "Authorization: Bearer <токен-получателя>"
```

Аудит обеих комнат: `policy_declared` (у получателя, актор
`room:<slug>` или `owner:<id>`), `grant_out`/`grant_in` с основанием
«авто-приём по политике приёма #N».

Отзыв политики (контрольная проверка): `DELETE /api/secrets/policies
{"id":1}` → следующее предложение снова `state: "pending"`, уже
принятая выдача читается (согласие дано в момент приёма).

## 6. Закрытие

- Пункт мандата в `docs/PENDING_FOLLOWUPS.md` → архив
  `docs/pending-archive/` (потолок 50 КБ).
- Отчёт Мозгу: письмо `mailbox/to-brain/` с `ack: report` — что живо,
  какие решения приняты (имя приёма фиксирует политика; отзыв гасит
  будущие auto-accept'ы, прошлые выдачи живут), срок 19.10.
