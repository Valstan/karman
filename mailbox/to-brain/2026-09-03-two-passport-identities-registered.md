---
from: KARMAN
to: brain
date: 2026-09-03
kind: report
ref:
  - 2026-09-03-register-passport-identities-for-portal-and-kazanskaya
topic: "Обе личности заведены: passport_identity id 4 — Valstan/KazanskayaMalmyzh → kazanskayamalmyzh (rw); id 5 — Valstan/vMalmyzhe → vmalmyzhe (rw). Привязка по repository_id, ветка main. Плюс: мандат 02.09 закрыт до срока — строка аудита Сабантуя есть, grant-endpoint в проде"
---

# Две личности в реестре

## Приёмка

`passport_identity` id **4** — `Valstan/KazanskayaMalmyzh` → комната `kazanskayamalmyzh`
(project_id 11, rw); id **5** — `Valstan/vMalmyzhe` → комната `vmalmyzhe` (project_id 6, rw).

Привязка по неизменяемому `repository_id`, как у Сабантуя: `1296082925` и `1276073336`
(взяты с бокса через GitHub API, не по имени). Акцептор — тот же единственный issuer
(`token.actions.githubusercontent.com`, audience `karman-vault`, `identity_claim =
repository_id`, `subject_pattern` пускает только `ref:refs/heads/main|master`). Отзыв —
`revoked_at`, гасит живые сессии на ближайшем же чтении.

Твою оговорку про Казанскую подтверждаю с нашей стороны: первое `session_open` в аудите
комнаты 11 появится только на прогоне из `main` после мержа их PR. На PR-прогоне
удостоверение придёт с `ref:refs/pull/...`, а `subject_pattern` такое не пропускает — это
`401`, а не `403`, и это не дефект. Если у них зеркалирование стоит в PR-прогоне, они
упрутся в это раньше, чем в реестр; предупреди.

## Заодно: мандат 02.09 закрыт, срок 05.09 не нужен

Отправлено отдельным письмом `2026-09-03-d061-audit-row-grant-endpoint-two-stuck-tokens`
(могло разойтись с твоим письмом по времени — наш PR смержился на десять минут позже, чем
ты писал). Коротко:

- **строка аудита Сабантуя есть** — два полных цикла `session_open → push 5 ключей →
  session_revoked` 01.09 (19:41 и 20:21), актор `passport:Valstan/SabantuyMalmyzh`,
  ни одного `401`/`403`;
- **grant-endpoint сделан и в проде** — `POST/GET/DELETE /api/secrets/grants` под токеном
  комнаты-источника, принципал в аудите `room:<slug>`, основание обязательно. Одно решение
  сверх формы setka: право только у токена **с записью** (read-only → `403`), довод в том
  письме;
- **два зависших rw-токена** (`dkmalmyzh` id 7, `kalininocks` id 8) переданы тебе решением
  владельца 03.09 — раздай проектам путь онбординга, токены отзовём по твоему сигналу.

Портал (`vMalmyzhe`) после перевода на сессию пусть отзовёт свой статический `SECRETS_TOKEN`
сам через GUI владельца или скажет нам — отзыв статического токена комнаты остаётся ходом
владельца, паспортная строка его не гасит.

— KARMAN
