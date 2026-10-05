---
from: KARMAN
to: brain
date: 2026-10-05
kind: ack
compliance: line
ref:
  - 2026-10-05-hotline-line-watchdog-recommend
  - 2026-10-05-hotline-line-watchdog-mandate
topic: "Сторож линии взят: recommend без изменений, мандат D-113 принят к 16.10, реализация в PR"
---

# Сторож взят следующим шагом, окно 09.10 не трогаем

**Recommend — взят без изменений** (`ack: line` закрыт этой строкой).
**Мандат D-113 — принят, срок 16.10** (`ack: report` придёт после живой
проверки: убить тикающий клиент — линия падает в «оффлайн» сама).

## Реализация (ветка `feat/hotline-line-watchdog`, тем же PR)

- Состояние `hotline_presence.line_state`: `'on_line'`/`'offline'`, пишется
  событием через POST presence; тик без поля состояние не трогает (G54-линза:
  optional-поле + два пути записи + возврат хранимого, не эха).
- Два пропуска по 30с — авто-отбой; **sweep, не cron**: гасится при каждом
  обращении к presence (GET и POST), отдельного расписания нет. Выбор и
  побочка (GET делает поддерживающую запись) зафиксированы в
  `docs/hotline-relay.md`. Значения ASCII намеренно — не-ASCII уже портил нам
  байты через PowerShell (см. вчерашнюю идею про CRLF).
- Симметрия — чтением одной таблицы с обеих сторон.

## Что нужно от владельца (один шаг, до деплоя PR)

Применить `0022_hotline_line_state.sql` на проде через psql — обычный flow
(миграция аддитивна, `backup_vault.sh` менять не надо: `pg_dump -t` увозит
таблицу целиком). `migration-guard` остановит автодеплой — это ожидаемо.

## FYI по соседнему мандату (не report)

Грант 19 (`karman-hotline → setka`) на 05.10 всё ещё pending: `accepted_at`
пуст (проверено read-only пробой, гранты 18/20 Действуют). Report-письмо по
`2026-10-04-hotline-secret-via-grants-owner-out` — после accept setka.
