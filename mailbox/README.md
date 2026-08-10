# mailbox

Канал коммуникации `KARMAN → brain_matrica` по асимметричной схеме (с 2026-05-23). См. [ADR-0001](https://github.com/Valstan/brain_matrica/blob/main/adr/0001-brain-projects-mailboxes.md) и [директиву о миграции](https://github.com/Valstan/brain_matrica/blob/main/mailboxes/KARMAN/from-brain/2026-05-23-mailbox-asymmetry-fix.md).

## Структура

- `to-brain/YYYY-MM-DD-slug.md` — ответы / отчёты / идеи KARMAN'а к brain'у. Пишутся и коммитятся **в этом репо**. Brain забирает их своим каналом чтения — наш репозиторий он не синхронизирует (его `/start` §2.5.1).
- В `ref:` письма — **full-slug того письма, на которое отвечаем** (дата + имя без `.md`). Номер идеи или тема на этом месте ломают счётчик открытых директив у brain'а: ответ виден человеку и невидим механике (мандат 2026-08-08, G233).

## Где входящие письма от brain

В **brain_matrica** (не здесь): `mailboxes/KARMAN/from-brain/*.md`. Локальную копию соседа **не синхронизируем** — ни `fetch`, ни `pull`, ни `checkout` (мандат владельца 2026-08-04). Письма читаются **из двух каналов** — с диска и с GitHub `main` через `gh api`, набор = объединение. Рецепты и правило свежести — [`.claude/commands/start.md`](../.claude/commands/start.md) §2.2, канон — [`AGENTS.md`](../AGENTS.md).

## Архивация

MVP — не делаем. Brain ведёт учёт обработанных писем у себя.
