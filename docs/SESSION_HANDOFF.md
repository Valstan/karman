# Session Handoff

> Sticky-note для непрерывности между сессиями KARMAN. Перезаписывается через
> `/close_session` — историю смотри через `git log --follow -- docs/SESSION_HANDOFF.md`.

**Status:** ACTIVE
**Updated:** 2026-06-04
**Branch:** docs/session-2026-06-04 (PR с доками); код — в `main`
**Прод:** **НОВЫЙ Next.js стек ЗАДЕПЛОЕН и обслуживает** (`78de2c3`) на
`4ce93c2b59f9.vps.myjino.ru`. Старый `karman-api` отключён (`inactive/disabled`).

---

## Текущая нитка

Новый единый Next.js-стек **выкачен в прод** (катовер 2026-06-04). Перед деплоем сверена
схема с боевой БД (`pg_dump --schema-only`) и устранены расхождения, которые ломали бы INSERT'ы
(bigint-identity, NOT NULL без дефолтов, недостающие колонки, ручной FK-каскад). Деплой проверен
end-to-end (health 200, редиректы гарда, login-форма доходит до БД). Ждём **приёмочный тест
пользователя**: вход с реальными кредами + проверка, что дашборд/банки/кредиты/платежи показывают
данные.

## Следующий шаг

1. **Дождаться результата входа пользователя** на https://4ce93c2b59f9.vps.myjino.ru.
   Если данные/вход не в порядке — откат (2 команды, БД-данные/схему НЕ меняли, менялись только
   роль+nginx):
   ```bash
   sudo cp /home/valstan/karman/nginx_backups/karman.20260604_004212.pre-nextjs.bak /etc/nginx/sites-available/karman
   sudo nginx -t && sudo systemctl reload nginx && sudo systemctl enable --now karman-api
   ```
2. **Смержить doc-PR этой сессии** (OPERATIONS + handoff + mailbox).
3. Регулярные деплои далее: `scripts/deploy.sh` (`git pull → npm ci → build → restart → health`).

## Контекст

- **План:** отдельного файла нет (рефакторинг-план выполнен и смержен ранее, PR #3).
- **Связанные коммиты сессии:** `78de2c3` готовность к деплою (схема+сервисы+build-фиксы, PR #5).
  Деплой — действиями на сервере (не в git): роль `karman_app`, `/etc/karman.env`,
  `karman.service`, nginx → :3000.
- **Открытые PR:** doc-PR этой сессии (OPERATIONS/handoff/mailbox); основной код (#5) смержен.
- **Открытые вопросы для пользователя:** результат приёмочного входа в прод.

## Прод-инфра (как устроено сейчас)

- Сервис: `karman.service` (systemd, `User=valstan`) → `node .next/standalone/server.js` на
  `127.0.0.1:3000`, `enabled`, `Restart=on-failure`. Env — `/etc/karman.env` (root:root 600):
  `SESSION_SECRET` (свежий) + `DATABASE_URL=postgres://karman_app:<pwd>@/karman_db?host=/var/run/postgresql`.
- БД-роль приложения: `karman_app` (LOGIN, пароль, гранты SELECT/INSERT/UPDATE/DELETE +
  sequences). Документированный peer-сокет под `valstan` НЕ работает (pg_hba требует пароль).
- nginx: единый `location / → :3000` на :80 и :443 (SSL Let's Encrypt сохранён). Бэкап старого
  конфига — `nginx_backups/karman.20260604_004212.pre-nextjs.bak`.
- Бэкап БД перед деплоем: `backups/karman_db_predeploy_20260604_003404.sql.gz`.

## Failed approaches (этой нитки)

- **Документированный `DATABASE_URL` (peer-сокет под `valstan`)** — на боевом сервере pg_hba
  требует пароль → не сработал. Решение: отдельная login-роль `karman_app` с паролем.
- **`information_schema` с самодельным quoting'ом** дал пустой `column_default` (ложно «нет
  дефолтов у id») — авторитетный источник для сверки только `pg_dump --schema-only`.
- **`ff-merge` на сервере удалил трекнутые `static/`, `nginx_backups/`** — `nginx_backups/`
  пришлось `mkdir -p` перед бэкапом. `frontend_dist/` был untracked → уцелел.

## Не забыть (low-priority)

- Категории документов не моделируются в UI: новые документы пишутся в «Прочее» (`category_id=8`).
  Когда появится выбор категории — убрать хардкод в `lib/services/documents.ts`.
- Старый env старого сервиса `/etc/systemd/system/karman-api.env` содержит прежний SESSION_SECRET
  (сервис отключён) — можно вычистить при желании.
- При первом заходе на новый стек все пользователи разлогинятся (cookie `karman_session_v2`).
