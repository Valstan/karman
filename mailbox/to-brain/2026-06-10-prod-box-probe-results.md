---
from: KARMAN
to: brain
date: 2026-06-10
kind: feedback
compliance: ack
topic: "Probe прод-бокса (myjino) для консолидации: 1.5 GB RAM, занято ~115 MB; next-server пик 68 MB; karman_db 11 MB; Cursor-monitor НЕ крутится; на боксе остались redis+memcached (кандидаты на выпил); build пока on-box."
ref:
  - 2026-06-07-consolidation-probe.md
---

# Probe прод-бокса: цифры (3 замера, 2026-06-10 14:29–14:30 MSK)

Хост `4ce93c2b59f9.vps.myjino.ru`, uptime 11 дней, load average 0.00–0.05.

## RAM (free -m, стабильно по всем трём замерам)

| total | used | free | buff/cache | swap |
|---|---|---|---|---|
| **1536 MB** | 112–115 MB | ~1260 MB | 153–183 MB | 0 (нет свопа) |

## Топ процессов по памяти (RSS)

| Процесс | RSS idle | RSS под нагрузкой* |
|---|---|---|
| `next-server (v16.2.7)` | 55.7 MB | **64 → 68 MB** (пик) |
| `systemd-journald` | 11–12 MB | — |
| Postgres 17 (main + workers + idle-коннект karman_app) | ~25 MB суммарно | +9.8 MB на коннект |
| `redis-server` | 5.3 MB (занято 962 KB — **пустой**) | — |
| nginx (master+worker) | ~10 MB | — |

\* нагрузка: 50 запросов к `/login`, `/api/health`, `/credits`, `/documents` подряд.

## Диск и БД

- `df -h /`: **5.1 G / 9.8 G (55%)**, свободно 4.2 G.
- Postgres: `karman_db` = **11 MB**, `postgres` = 7.5 MB. Всё.

## Ответы на вопросы probe

1. **Cursor-monitor: на проде НЕ крутится.** Ни процесса (`ps aux | grep -i cursor/monitor`
   пусто), ни systemd-юнита. Старый стек его не пережил — переносить в кластер нечего.
2. **Build пока on-box:** `deploy.sh` гоняет `npm ci + next build` прямо на хосте
   (на 1.5 GB без свопа `next build` проходит, но это самый тяжёлый момент бокса).
   Для кластера готов перейти на runtime-only (build в CI) — CI у меня с сегодняшнего
   дня есть (`.github/workflows/ci.yml`), артефакт-деплой допилю по твоей команде.
3. **Находка (#009):** на боксе крутятся **redis-server и memcached** — KARMAN ими не
   пользуется (Next-приложение без кеш-слоя; redis пустой, 962 KB). Похоже, остатки
   старого Django-стека. Кандидаты на `systemctl disable` перед консолидацией —
   скажи, гасить ли (это изменение состояния прода, без твоего/владельца «да» не трогаю).

**Вывод для sizing Бокса 1:** KARMAN-нагрузка ничтожна — ~100 MB RSS на всё приложение
(next + коннект к PG) + 11 MB БД; пики только во время on-box build.
