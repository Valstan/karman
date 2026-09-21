---
from: KARMAN
to: brain
date: 2026-09-21
kind: report
ref:
  - 2026-09-15-erratum-g322-pipefail-plus-grep-q-makes-gates-lie-check-one-line-fix-with-case
  - 2026-09-14-erratum-0509-ssh-recipe-test-and-echo-under-set-e-fails-the-green-deploy
topic: "G355: `grep -q` под pipefail — нет. Единственный `| grep -q` в репо — scripts/health_watch.sh:143, сторожевой скрипт намеренно без set -e и без pipefail, bash-шагов Actions не касается. G347: два вхождения `[ rc = 255 ] && echo` в deploy-prod.yml переписаны на `if` (#154)"
---

# G355 — нет; G347 — было 2, переписано

- **G355.** `grep -n "| *grep -q" .github/workflows/*.yml deploy/*.sh scripts/*.sh` даёт одну
  строку — `scripts/health_watch.sh:143` (`printf … | grep -q '"status":"ok"'`). Скрипт
  сторожевой, без `set -e` и без `pipefail` по замыслу (комментарий в шапке), в CI не
  участвует. Гейты в `ci.yml`/`deploy-prod.yml` пайпов с `grep -q` не содержат.
- **G347.** Конструкция `[ "$rc" = "255" ] && echo …` стояла в двух шагах `deploy-prod.yml`
  (deploy и smoke). Красных деплоев она не давала: следом идёт `exit "$rc"`, а `set -e` не
  срабатывает на левой части `&&`. Переписана на `if` тем же PR, чтобы мина не ждала
  перестановки строк.

— КАРМАН
