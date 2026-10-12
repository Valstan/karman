# Session Handoff

> Sticky-note для непрерывности между сессиями KARMAN. Перезаписывается через
> `/close_session` — историю смотри через `git log --follow -- docs/SESSION_HANDOFF.md`.

**Status:** В РАБОТЕ — мандат S1+S2 (D-119): LIVE сделан, остаётся отчёт Мозгу
**Updated:** 2026-10-12
**Branch:** `feat/access-selfserve-s5-live` (итоги живого слайса: runbook,
PENDING, этот handoff); сама фича уехала слайсами #220–#223 в main.
**Прод:** код #223 (слайс 4) + миграция 0023 применена вживую 12.10; env бокса
`VAULT_URL` + `SECRETS_TOKEN` (relay перешёл на vault-first, рестарт зелёный,
health 200); политика #1 и первый auto-accept (grant 21, `state: active`)
живы; тесты 544.

---

## Текущая нитка

Мандат brain 09.10 (`2026-10-09-access-roadmap-s1s2-mandate.md`, `ack: report`):
**S1** — сервисные токены в своих комнатах + восстановление из vault при старте
(собакоедение `vault-client`) + инвентарь с `last_used` + ротация перекрытием;
**S2** — allowlist-политика приёма, авто-accept с аудитом на движение.
Отчёт Мозгу — **19.10**; S3 после отчёта. План-карта —
`../brain_matrica/docs/plans/access-selfserve-roadmap.md`, условия в
`docs/PENDING_FOLLOWUPS.md` § «Мандаты (в работе)».

## Следующий шаг

**Отчёт Мозгу 19.10** (`ack: report`) — письмом в `mailbox/to-brain/`: что живо
(S1: env `VAULT_URL`/`SECRETS_TOKEN`, vault-first, инвентарь, ротация
перекрытием в runbook; S2: политика + авто-accept + аудит с номером политики),
принятые решения (имя приёма фиксирует политика; отзыв гасит будущие
auto-accept'ы, принятые выдачи живут), инциденты дня (ключ удалён из GUI без
аудита — дыра `deleteItem` в PENDING; guard пропустил деплой без 0023 —
сбывшийся пункт PENDING). Ответный ход владельца: **отозвать старый токен 211**
(`/secrets/19`, GUI — plaintext потерян, отзыв — гигиена). После отчёта —
гашение пункта мандата в PENDING (архив) и S3.

**Прогресс:** ✅ слайс 1 — инвентарь токенов (`/secrets/tokens`, PR #220).
✅ слайс 2 — vault-client + восстановление секретов из vault при старте
(`HOTLINE_RELAY_SECRET` через runtime-резолвер, env — фолбэк, PR #221).
✅ слайс 3 — политика приёма: миграция 0023 `secrets_grant_policy` + зона
политий (`declare/revoke/list/match`) + авто-accept в `proposeGrantByToken`
(имя приёма фиксирует политика, аудит несёт номер; `isUniqueViolation` починен
на `.cause` — drizzle оборачивает ошибки драйвера, гонки были бы 500), PR #222.
✅ слайс 4 — GUI политик (панель на странице комнаты, действия владельца)
+ машинный путь `POST/GET/DELETE /api/secrets/policies`, PR #223.
✅ слайс 5 (LIVE, 12.10) — 0023 применена на проде вручную (инцидент: код
слайса 4 уехал раньше схемы, guard смотрит только `HEAD~1` — пойман пробой
`to_regclass`); токен `karman-hotline` перевыпущен (281); `VAULT_URL` +
`SECRETS_TOKEN` в env бокса, рестарт зелёный, relay 200; **политика #1
объявлена (GUI владельца), первый авто-принятый grant 21 — `state: active`,
аудит обеих комнат несёт «авто-приём по политике приёма #1»**; случайно
удалённый из GUI ключ `HOTLINE_RELAY_SECRET` восстановлен из env-фолбэка;
runbook — `docs/access-selfserve-runbook.md`.

## Контекст

- **План:** `docs/hotline-relay.md` (контракт Ф1), `docs/write-paths.md` (D-096),
  `docs/secrets-manager.md` (vault).
- **Связанные коммиты сессии:** #197 сторож линии → #200 фикс INSERT (пойман
  живой пробой) → #201 report Мозгу (D-113) → #202 бэкап `family_*` → #203 витрина
  `/hotline` → #199 ре-триаж PENDING → #205 report по гранту 19 → #206 харнесс
  pglite → #207 16 инвариантов `secrets.ts` → #208–#211 три зоны `secrets.ts`
  (1542 → 818 строк) → #213 гейт «таблица бэкапа ↔ схема» → #214 CVE
  `source-map-js`.
- **Открытые PR:** нет.
- **Открытые вопросы для пользователя:** `auth_user` в бэкапе (решение
  «включать/не включать» — parked в PENDING, гейт бэкапа уже стоит). Очередь
  кандидатов (R2, тесты сервисов) — после мандата.

## Не забыть (low-priority)

- Кнопка «выдать коды 2FA заново» (владелец) — легаси-строки без соли ещё в
  таблице; миграция 0020 применена, нужна кнопка.
- Учебное восстановление бэкапа — следующий drill Q4 (с владельцем, нужен его
  закрытый gpg-ключ); там же учебная сработка сторожа `health_watch.sh`.
- G321 (склейка аргументов `ssh … bash -s`), `readSessionUid` и
  `reorderFamilyPeopleAction` в deadcode-отчёте — триажить по #028.
- Правило от 06.10: `npm audit fix` не применять вслепую — сначала
  `git diff --stat`, точечные CVE лечить `overrides` (письмо Мозгу
  `2026-10-06-npm-audit-fix-breaks-unrelated-tree.md`).