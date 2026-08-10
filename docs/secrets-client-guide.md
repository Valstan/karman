# Менеджер секретов KARMAN — гайд для проекта-клиента

Как любому проекту экосистемы хранить свои секреты в зашифрованном менеджере KARMAN
и читать их обратно — по своему токену, без участия человека в рантайме. Прочитав
этот файл, агент любого проекта может подключиться к **своей** комнате.

## Идея

- У каждого проекта — **своя «комната»** (project) в KARMAN. Секреты лежат
  **зашифрованными** (AES-256-GCM, мастер-ключ только в env сервера KARMAN).
- Проект ходит к API по **Bearer-токену**: read-write токен умеет и сохранять, и читать.
- **Токен = удостоверение комнаты.** Он заскоуплен **только на свою комнату** — по нему
  нельзя прочитать или перезаписать чужие секреты. Знать slug/id комнаты для работы не нужно:
  токен сам приводит запрос в нужную комнату.

## Каждому проекту — своя комната

Заведены комнаты (slug — человекочитаемая метка в UI владельца; для подключения он не нужен):

| Проект | slug комнаты |
|---|---|
| MatricaRMZ | `matricarmz` |
| GONBA | `gonba` |
| SARAFAN | `setka` |
| SabantuyMalmyzh | `sabantuymalmyzh` |
| vMalmyzhe | `vmalmyzhe` |
| DKMalmyzh | `dkmalmyzh` |
| KalininoCKS | `kalininocks` |
| trener | `trener` |
| brain | `brain` |
| KARMAN | `karman` |

> Этот список — снимок; источник истины — страница `/secrets`. Новая комната заводится
> self-serve (ниже) или владельцем в KARMAN → `/secrets`.

## Паспортный вход (штатный путь с волны 2 ADR-0012)

Если у проекта есть CI с OIDC — **никакой общей строки не нужно**: воркфлоу предъявляет
подписанное удостоверение своего репозитория и получает короткоживущий токен своей комнаты.

```bash
# в GitHub Actions, permissions: id-token: write
ASSERTION="$(curl -sf -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN"   "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=karman-vault" | jq -r .value)"
curl -sf -X POST https://831d0ce99bdf.vps.myjino.ru/api/secrets/session   -H "Authorization: Bearer $ASSERTION"
# → 201 {"ok":true,"token":"skm_…","expiresAt":"…","slug":"myproject","canWrite":false}
```

Дальше — обычный API ниже, `SECRETS_TOKEN` = полученный `token`. Личность должна быть заведена
владельцем в реестре один раз (`403` = «личность не зарегистрирована»); комната автоматически
**не заводится**. Своя интроспекция — `GET /api/secrets/self`, самоотзыв — `DELETE /api/secrets/session`.
Полный контракт и рецепт — `docs/passport-server.md`.

## Self-serve onboarding по общему ключу (break-glass)

> С волны 2 ADR-0012 этот путь — **аварийный**, а не штатный: он держится на общей строке,
> которая ничего не говорит о предъявителе. Владелец может погасить его переменной
> `PROVISION_KEY_ENABLED=false` (тогда роут отвечает `503`).

Мандат brain 2026-07-12 (амендмент §6 ADR-0006): новая проектная сессия заводит свою комнату
**сама**, без кликов владельца в MFA-UI. Нужен **provisioning-ключ** `VAULT_PROVISION_KEY`
(секрет #008-класса, у brain/владельца; читать чужие ячейки или выпускать токены к живым
комнатам им нельзя).

```bash
curl -X POST https://831d0ce99bdf.vps.myjino.ru/api/secrets/provision \
  -H "Authorization: Bearer $VAULT_PROVISION_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slug":"myproject","name":"MyProject"}'
# → 201 {"ok":true,"projectId":N,"slug":"myproject","token":"skm_…","tokenPrefix":"skm_…"}
```

- `slug` — латиница/цифры/дефис (метка комнаты в UI); `name` опционален (по умолчанию = slug).
- `token` в ответе — **read-write токен комнаты, показывается ОДИН раз**: сразу положи его
  в рантайм-секрет проекта (`SECRETS_TOKEN`) и дальше работай по обычному API ниже.
- **Комната уже существует?** Не тупик (ADR-0010): если она **пуста** (0 секретов, 0 карточек)
  и ни один её токен ни разу не использовался — тот же `POST` выпустит **первый рабочий
  rw-токен** (`201`, старые невостребованные токены отзываются, аудит `provision_first_token`).
  Так онбордится комната, которую завели заранее, а токен потерялся при доставке.
- Коды: `201` создано / первый токен выдан; `409` комната живая — в ней есть секреты, карточки
  или использованный токен (токен НЕ выдаётся — переоткрытие только владельцем под 2FA);
  `401` неверный provisioning-ключ; `503` provisioning не сконфигурирован на сервере.
- Каждая операция (включая отказы) пишется в аудит-лог комнаты/сервиса.

## Онбординг через владельца (запасной путь)

1. Владелец выдаёт твоему проекту **read-write токен** (KARMAN → `/secrets` → твоя комната →
   Токены). Токен показывается **один раз** — владелец передаёт его тебе разово (paste-message).
2. Положи токен в **рантайм-секрет проекта** — env-переменную `SECRETS_TOKEN` (или секрет-стор
   деплоя/CI). **НИКОГДА не коммить в git** (ни в версионируемый `.env`, ни в код).
3. Сделай smoke-проверку (ниже) — пустая комната вернёт `200 {"secrets":{}}`.
4. Дальше сохраняй/читай свои секреты по API.

Токены, выданные владельцем, **без срока** (не истекают). Ротация — ручная: если токен утёк/
потерян, попроси владельца отозвать старый и выдать новый в `/secrets`. Токены паспортной сессии,
наоборот, **со сроком** (`expiresAt`, по умолчанию час) и гасятся сами — ротация там сводится
к перезапуску деплоя.

## Эндпоинт

```
https://831d0ce99bdf.vps.myjino.ru/api/secrets
```

## Первое подключение (smoke)

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $SECRETS_TOKEN" \
  https://831d0ce99bdf.vps.myjino.ru/api/secrets
# 200 — токен валиден (пустая комната вернёт {"secrets":{}}); 401 — токен битый/отозван.
```

## Сохранить свои секреты (POST, bulk upsert)

```bash
curl -X POST https://831d0ce99bdf.vps.myjino.ru/api/secrets \
  -H "Authorization: Bearer $SECRETS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"secrets":{"DB_PASSWORD":"…","SOME_API_KEY":"…"}}'
# → {"ok":true,"written":2}
```

## Прочитать обратно (GET)

```bash
# все секреты проекта:
curl -H "Authorization: Bearer $SECRETS_TOKEN" https://831d0ce99bdf.vps.myjino.ru/api/secrets
# → {"secrets":{"DB_PASSWORD":"…","SOME_API_KEY":"…"}}

# один ключ:
curl -H "Authorization: Bearer $SECRETS_TOKEN" \
  "https://831d0ce99bdf.vps.myjino.ru/api/secrets?key=DB_PASSWORD"
```

## Node-сниппет

```js
const BASE = 'https://831d0ce99bdf.vps.myjino.ru/api/secrets';
const headers = {
  Authorization: `Bearer ${process.env.SECRETS_TOKEN}`,
  'Content-Type': 'application/json',
};

export async function saveSecrets(secrets) {
  const r = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ secrets }) });
  if (!r.ok) throw new Error(`secrets save failed: ${r.status} ${await r.text()}`);
  return r.json(); // { ok, written }
}

export async function loadSecrets() {
  const r = await fetch(BASE, { headers });
  if (!r.ok) throw new Error(`secrets load failed: ${r.status} ${await r.text()}`);
  return (await r.json()).secrets; // { KEY: value, ... }
}
```

## Python-сниппет

```python
import os, requests

BASE = "https://831d0ce99bdf.vps.myjino.ru/api/secrets"
HEADERS = {"Authorization": f"Bearer {os.environ['SECRETS_TOKEN']}"}

def save_secrets(secrets: dict) -> dict:
    r = requests.post(BASE, headers=HEADERS, json={"secrets": secrets}, timeout=10)
    r.raise_for_status()
    return r.json()  # {"ok": True, "written": N}

def load_secrets() -> dict:
    r = requests.get(BASE, headers=HEADERS, timeout=10)
    r.raise_for_status()
    return r.json()["secrets"]  # {"KEY": "value", ...}
```

Типичный паттерн «восстановить, если потерял локальную копию»:

```js
let local = readLocalEnvSomehow();
if (!local || Object.keys(local).length === 0) {
  local = await loadSecrets(); // подтянуть из менеджера
}
```

## Ключ, общий с другим проектом (выданный доступ)

Если один и тот же ключ нужен двум проектам, **копировать его между комнатами не надо** —
владелец комнаты-источника выдаёт вашей комнате доступ к этому ключу. Значение остаётся
в одном месте, вы читаете его **своим обычным токеном**, под именем, о котором договорились:

```bash
curl -H "Authorization: Bearer $SECRETS_TOKEN" \
  "https://831d0ce99bdf.vps.myjino.ru/api/secrets?key=VMALMYZHE_INGEST_KEY"
# → {"secrets":{"VMALMYZHE_INGEST_KEY":"…"}}
```

Со стороны клиента ничего нового: выданные ключи приходят в тот же `GET /api/secrets`
вперемешку со своими, отличать их не нужно. Что стоит знать:

- **Пока выдачи нет (или ключ ещё не заведён в источнике) — `404`.** Это нормальное
  состояние ожидания: как только ключ появится, тот же запрос начнёт отдавать `200`,
  менять на вашей стороне ничего не нужно.
- **Записать такой ключ через `POST` нельзя — `403`.** Он принадлежит комнате-источнику;
  ротацию делает её владелец, вы сразу получаете новое значение.
- **Доступ отзываем** без смены самого секрета: после отзыва ключ снова даёт `404`.
- Каждое ваше чтение видно в аудите комнаты-источника — выдача не бывает молчаливой.

Запросить общий ключ — через владельца (или brain, если ключ ecosystem-wide): нужны
имя ключа у источника, ваша комната и имя, под которым вы хотите его видеть.

## Правила и коды

- Имя ключа — как env-переменная: `^[A-Za-z_][A-Za-z0-9_]*$`. Значение ≤ 64 КБ, до 200 ключей за POST.
- Запись — upsert (повторный POST с тем же ключом перезапишет значение). Удаление секрета — только
  владелец в UI (по токену удаления нет).
- Коды: `200` ок; `400` плохое тело; `401` нет/недействителен токен; `403` токен только для чтения
  (нужен read-write) **или** попытка записать ключ, приходящий по выданному доступу; `404` нет
  ключа (GET ?key=); `429` слишком часто (лимит ~60/мин).
- Сами значения наружу видны только по валидному токену; в логах/ответах об ошибках их нет.
