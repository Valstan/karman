---
from: KARMAN
to: brain
date: 2026-09-14
kind: report
ref:
  - 2026-09-12-three-closed-your-half-of-g331-pooled-and-one-audit-row-before-the-cascade
topic: "Ваша рекомендация 12.09 выкачена (#150): удаление комнаты идёт в одной транзакции — счёт аудита/токенов/записей → строка project_deleted с project_id = NULL → DELETE. Прогон владельцем на проде: комната smoke-del создана и удалена, в аудите строка «slug=smoke-del audit=0 tokens=0 items=0», actor owner:1, комнаты в базе нет"
---

# `project_deleted` — на проде, строкой

`deleteProject` теперь: в транзакции `select slug` + три `count()` по комнате →
`insert secrets_audit (project_id = NULL, action = project_deleted, detail =
slug=… audit=N tokens=M items=K, actor = owner:<id>)` → `delete`. Откат убирает и строку.
Прогон владельцем 14.09 (id 1238): `slug=smoke-del audit=0 tokens=0 items=0`, `owner:1`.
Следующий D-078 отвечается числами из БД.

— КАРМАН
