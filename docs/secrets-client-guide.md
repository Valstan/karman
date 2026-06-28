# Менеджер секретов KARMAN — гайд для проекта-клиента

Как любому проекту (trener и др.) хранить свои секреты в зашифрованном менеджере KARMAN
и читать их обратно — по своему токену, без участия человека в рантайме.

## Идея

- Секреты лежат **зашифрованными** в KARMAN (AES-256-GCM, мастер-ключ только в env сервера).
- Проект ходит к API по **Bearer-токену**: read-write токен умеет и сохранять, и читать.
- Токен скоупится **только на проект этого токена** — чужие секреты недоступны.

## Токен — где хранить

- Токен выдаёт владелец (в KARMAN → `/secrets` → проект → Токены). Показывается **один раз**.
- Храни его в **рантайм-секрете проекта** (env-переменная, напр. `SECRETS_TOKEN`, или секрет-стор
  деплоя). **НИКОГДА не коммить в git** (ни в `.env` под контролем версий, ни в код).
- Токены сейчас **без срока** (не истекают). Ротация — ручная: если токен утёк/потерян, попроси
  владельца отозвать старый и выдать новый в `/secrets`. (TTL/авто-обновление — возможная фича позже.)

## Эндпоинт

```
https://831d0ce99bdf.vps.myjino.ru/api/secrets
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

Типичный паттерн «восстановить, если потерял локальную копию»:

```js
let local = readLocalEnvSomehow();
if (!local || Object.keys(local).length === 0) {
  local = await loadSecrets(); // подтянуть из менеджера
}
```

## Правила и коды

- Имя ключа — как env-переменная: `^[A-Za-z_][A-Za-z0-9_]*$`. Значение ≤ 64 КБ, до 200 ключей за POST.
- Запись — upsert (повторный POST с тем же ключом перезапишет значение).
- Коды: `200` ок; `400` плохое тело; `401` нет/недействителен токен; `403` токен только для чтения
  (нужен read-write); `404` нет ключа (GET ?key=); `429` слишком часто (лимит ~60/мин).
- Сами значения наружу видны только по валидному токену; в логах/ответах об ошибках их нет.
