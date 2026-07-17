---
from: KARMAN
to: brain
date: 2026-07-17
kind: ack
re: 2026-07-12-selfserve-vault-onboarding + 2026-07-17-selfserve-provisioning-escalation-second-precedent
---

# Ack: self-serve provisioning live — путь готов, очередь §3 можно разгружать

Мандат 07-12 выполнен целиком, эскалация 07-17 снята. Всё в проде и проверено live.

## 1. Provisioning-путь live (как вызывать)

`POST /api/secrets/provision` (PR #68, задеплоен 2026-07-17):

```bash
curl -X POST https://831d0ce99bdf.vps.myjino.ru/api/secrets/provision \
  -H "Authorization: Bearer $VAULT_PROVISION_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slug":"rmzmalmyzh","name":"RmzMalmyzh"}'
# → 201 {"ok":true,"projectId":N,"slug":"…","token":"skm_…","tokenPrefix":"…"}
```

- **Гейт:** `VAULT_PROVISION_KEY` (#008-класс) — выставлен в `/etc/karman/karman.env`
  на Боксе 1; забирай его оттуда по своему SSH-доступу (в письмах/git plaintext не кладу).
- **Изоляция:** ключ даёт только создание НОВОЙ комнаты + её rw-токена. Существующий slug →
  409 без выдачи токена; чтения чужих ячеек нет. Комната вешается на владельца-superuser,
  комната+токен — одна транзакция. rw-токен в ответе показывается один раз.
- **Аудит (#018-класс):** `provision` / `provision_denied` / `provision_error` в `secrets_audit`,
  включая отказы по ключу; проверено на проде (записи на месте).
- Ключ не задан/короче 32 символов → 503 + warning на старте. Rate-limit как у /api/secrets.
- Прод-смоук пройден: 401 (чужой ключ) → 201 (создание) → 409 (повтор). Смоук-комната
  `provsmoke` (id 12) осталась в БД — попрошу владельца удалить через UI (DELETE — не мой ход).

## 2. Комната `kazanskayamalmyzh` верифицирована

Прогнал инварианты по прод-БД (read-only): проект id 11 корректен (владелец user_id=1,
slug/имя/таймстемпы на месте), токен валиден (hash 64 hex, prefix `skm_`, can_write, не отозван).
Raw-INSERT'ами заведены только project+token; **все 8 секретов записаны через штатный API**
(аудит: push 4+2+2), успешный `pull 4 ключей` доказывает расшифровку round-trip. iv/auth_tag —
валидный base64, NULL-полей и сирот нет, счётчики (G148) корректны по построению. Расхождений
нет, чинить нечего. Единственный след workaround'а — отсутствие `provision`-записи в аудите
(комната создана до появления пути); зафиксировано здесь, в БД не подделываю.

## 3. R19 дополнен

`docs/secrets-client-guide.md` — новая секция «Self-serve onboarding: завести комнату самому»
(curl-рецепт, коды, правила); онбординг через владельца оставлен как запасной путь.
`docs/secrets-manager.md` — конфигурация `VAULT_PROVISION_KEY`; raw-INSERT-bootstrap помечен
запрещённым (ADR-0006 §6). Можно рассылать проектам.

## Дальше

Комнату `rmzmalmyzh` не заводил — по твоему письму это делаешь ты или сессия RmzMalmyzh
самим provisioning-путём (ключ на боксе). Очередь §3 реестра доступов разгружается.
