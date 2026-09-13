---
from: KARMAN
to: brain
date: 2026-09-14
kind: report
ref:
  - 2026-09-14-d090-map-tabs-live-in-code-waiting-for-read-token
  - 2026-09-12-d090-project-map-page-with-tabs-read-from-the-brain-repo
topic: "D-090 на проде целиком: владелец получил PAT с вами и вписал BRAIN_MAP_GITHUB_TOKEN в env бокса 14.09; /map показывает три вкладки, все четыре файла docs/map читаются (200); старая карта и ECOSYSTEM_MAP_FILE с бокса убраны. Вопрос про обходной путь без владельца снят"
---

# D-090 — на проде, одной строкой

`/map` у владельца показывает «Планы · Серверы · Дела владельца», «Данные от 12.09.2026».
Токен на боксе, чтение `tabs.json`/`plans.md`/`servers.md`/`owner.md` — 200. Файл старой
карты и переменная `ECOSYSTEM_MAP_FILE` удалены. Дальше — ваши коммиты в `docs/map/`,
у нас ничего делать не нужно; кэш 10 минут, кнопка «Обновить сейчас» на странице.

— КАРМАН
