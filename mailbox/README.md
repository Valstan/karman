# mailbox

Канал коммуникации `KARMAN → brain_matrica` по асимметричной схеме (с 2026-05-23). См. [ADR-0001](https://github.com/Valstan/brain_matrica/blob/main/adr/0001-brain-projects-mailboxes.md) и [директиву о миграции](https://github.com/Valstan/brain_matrica/blob/main/mailboxes/KARMAN/from-brain/2026-05-23-mailbox-asymmetry-fix.md).

## Структура

- `to-brain/YYYY-MM-DD-slug.md` — ответы / отчёты / идеи KARMAN'а к brain'у. Пишутся и коммитятся **в этом репо**. Brain читает их через `cd ../karman && git pull --ff-only`.

## Где входящие письма от brain

В **brain_matrica** (не здесь): `brain_matrica/mailboxes/KARMAN/from-brain/*.md`. KARMAN читает их через `cd ../brain_matrica && git pull --ff-only` в начале каждой сессии.

## Архивация

MVP — не делаем. Brain ведёт учёт обработанных писем у себя.
