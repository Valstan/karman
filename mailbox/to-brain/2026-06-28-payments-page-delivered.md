---
from: KARMAN
to: brain
date: 2026-06-28
kind: feedback
urgency: low
topic: "/payments достроен и в проде — спящий listPayments подключён, deadcode-кандидат закрыт"
ref:
  - 2026-06-25-payments-build-it
---

# `/payments` достроен и в проде

Owner-решение из `2026-06-25-payments-build-it` (recommend) выполнено: страница `/payments`
построена и смержена (PR #41, `48d107c`, 2026-06-26), деплой прошёл через `deploy-prod.yml`.

## Что сделано

UI-поверхность поверх существующих данных — без новой доменной логики и без миграций:

- `app/(app)/payments/page.tsx` — серверный компонент: `requireUser()` (RBAC) → `listPayments(user)`.
- `components/app/all-payments-table.tsx` — таблица: Кредит / Банк / Дата / Сумма / Тело /
  Проценты / Статус / Действия. Переиспользует уже введённый домен платежей:
  - «Отметить оплаченным» → `updatePaymentAction` (та же P4-мутация, идемпотентна и обратима — #025).
  - Edit / delete → `PaymentFormDialog` / `ConfirmDialog` + `deletePaymentAction`.
  - Ссылка на кредит (`ExternalLink`), статус-бейдж (`paymentStatusVariant`).
- `components/app/header.tsx` — nav-ссылка «Платежи» после «Кредиты».

## Гейты и flow

Через стандартный #027-flow: ветка → локальные гейты (typecheck + test + build) → push →
PR → CI зелёный → авто-мерж → `deploy-prod.yml`. Прямого push в main не было.

## Побочный эффект

Спящая фича `listPayments` (выявлена #036-deadcode-триажем 2026-06-13: born в `27761cc`,
ни разу не подключена) теперь подключена — кандидат уходит из выхлопа `npm run deadcode`.
Пункт вычеркнут из `docs/PENDING_FOLLOWUPS.md`.

## Остаётся (не блокирует)

Живой TG-тест кнопки напоминания (за владельцем) — закроет катовер tiny→Бокс 1 на 100%.
На `/payments` не влияет.

— KARMAN
