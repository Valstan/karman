# Session Handoff

> Sticky-note для непрерывности между сессиями KARMAN. Перезаписывается через
> `/close_session` — историю смотри через `git log --follow -- docs/SESSION_HANDOFF.md`.

**Status:** IDLE
**Updated:** 2026-06-10
**Branch:** main (PR #15 и #16 смержены; всё в проде)
**Прод:** `d60a0b5` (= main) на `4ce93c2b59f9.vps.myjino.ru`, health ok (деплой 2026-06-10
через новый `scripts/deploy_remote.sh` — отвязанный запуск + опрос лога, отработал штатно).

---

## Текущая нитка

_Нет — задачи сессии закрыты._ Сессия разгребла 6 директив brain одним заходом:

1. **Батч конфигов (PR #15):** `/obriv` (#021), autonomy-гейты #027 (`.claude/settings.json`
   `defaultMode: auto` + узкие allow/deny, `CLAUDE.md` с чертой #025), **CI заведён**
   (`.github/workflows/ci.yml`: typecheck+vitest+build на PR — раньше CI не было),
   `.gitignore` для `.claude/`, память #032/#033 (`/start` синкается ДО чтения handoff;
   `docs/PENDING_FOLLOWUPS.md` с метками старения), `scripts/deploy_remote.sh`.
2. **#035 tiered search Ф0+Ф1 (PR #16):** shared-модуль `lib/search/tiered-search.ts`
   (нормализация, многотокен AND, substring→subsequence→fuzzy, RU↔EN, подсветка) + подключение
   в таблицы кредитов/документов/банков. Ф2/Ф3 — в PENDING_FOLLOWUPS.
3. **Probe прод-бокса** (консолидация серверов): цифры в
   `mailbox/to-brain/2026-06-10-prod-box-probe-results.md`. Находки: Cursor-monitor на проде
   НЕ крутится; redis+memcached — остатки старого стека (кандидаты на отключение, спросить
   владельца/brain); build пока on-box.
4. **3 письма brain** в `mailbox/to-brain/2026-06-10-*` (батч-ack, probe, план #035).

## Следующий шаг

Активной нитки нет. На выбор новой сессии: пункты из `docs/PENDING_FOLLOWUPS.md`
(канонический список с метками старения — смотреть туда, не сюда); живая проверка
tiered search на проде; вопрос владельцу про отключение redis/memcached на проде.

## Контекст

- **План:** -
- **Связанные коммиты сессии:** `4796f4e` (PR #15, батч директив), `d60a0b5` (PR #16, поиск #035).
- **Открытые PR:** нет.
- **Открытые вопросы для пользователя:** из письма по #035 — подсветка жёлтым ок? fuzzy-группа
  «похожие» ок? (не блокируют, реализовано по дефолтам MatricaRMZ); redis/memcached на проде —
  отключать?

## Не забыть (low-priority)

Канонический список — `docs/PENDING_FOLLOWUPS.md` (#033, с метками старения). Витрина:
- #035 остаток: Ф2 комбобоксы, Ф3 серверный поиск + `pg_trgm` (когда объём вырастет).
- Завести ESLint — lint-гейта нет (не объявлять зелёным!).
- Бэкап `media/` на проде; множественные доп. файлы документа; превью-миниатюры сканов.
