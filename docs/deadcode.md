# Dead-code-гигиена (#036)

Директива brain 2026-06-10 ([pool #036](https://github.com/) — `036-static-deadcode-gate-llm-triage`):
бесплатный статанализатор даёт **кандидатов**, LLM только **триажит** их по
[#028](https://github.com/) (git-история символа → жив / мёртв / спящая фича).
**Report-only, никогда не авто-удалять.**

## Как запускать

```bash
npm run deadcode    # knip + depcheck, один прогон, всегда exit 0
```

- **knip** — основной сигнал (мёртвые файлы / экспорты / зависимости; понимает
  Next-conventions, postcss, tailwind). Конфиг — [`knip.jsonc`](../knip.jsonc).
- **depcheck** — кросс-проверка зависимостей (шумнее: не видит CSS-`@import`, его FP по
  tailwind-стеку погашены `--ignores` в [`scripts/deadcode.mjs`](../scripts/deadcode.mjs)).

### Конфиг knip — что и почему игнорируется

- `ignoreExportsUsedInFile: true` — экспорт, используемый внутри своего же файла,
  не мёртвый код, а лишь переэкспонированный (export-keyword избыточен; значение живо).
  Ловим только символы, не используемые **нигде**, включая собственный файл.
- `ignoreDependencies: server-only` (рантайм-страж границы, даёт Next транзитивно),
  `depcheck` (CLI второго сканера, вызывается, не импортируется).
- `ignore: components/ui/**` — вендоренная библиотека shadcn/ui (копии под
  `npx shadcn add`), не наш рукописный код. Наши компоненты — `components/app/**`.

## Процесс (ежемесячно)

1. `npm run deadcode` → список кандидатов.
2. Каждый **новый** кандидат — триаж по #028: git-история символа (когда введён,
   потребитель удалён рефактором = хвост → удалять, или никогда не подключался =
   спящая фича → re-триаж [#033](PENDING_FOLLOWUPS.md), решение владельца).
3. Идти по цепочкам (#028 приём 2): удаление символа рождает новые orphan'ы.
4. Мёртвое — удалять обычным PR; спящее — в `PENDING_FOLLOWUPS.md`; ничего не авто-удалять.

---

## Первый полный триаж — 2026-06-13

Прогон на чистом App Router (`app/` `components/` `lib/` `scripts/`). **Остатков
Vite/Express-эпохи не найдено** — миграция на Next 16 (`27761cc`) прошла без сирот-каталогов
(`frontend/`/`api/`/`server/` отсутствуют). Кандидаты — точечные.

### Удалено (хвосты рефакторов / born-unused, 0 ссылок, подтверждено git-историей)

| Символ | Файл | Вердикт |
|---|---|---|
| `@hookform/resolvers` | `package.json` (dep) | Формы используют `useForm` без resolver'а (валидация серверная, zod в actions/routes). Зависимость поставлена, ни разу не подключена. |
| `formatNumber` | `lib/format.ts` | Born-unused в миграции `27761cc`; 0 ссылок за всю историю. `numberFormatter` остаётся (его держит `formatPercent`). |
| `NOT_AUTHED` | `lib/actions/_internal.ts` | Born-unused; auth-гард уехал в `proxy.ts` (Edge-redirect до server-action), константа осиротела. |
| `ACCEPT_ATTR` | `lib/storage/media-paths.ts` | Дубль-сирота: клиент-форма держит свой `FILE_ACCEPT` (`media-paths.ts` тянет `node:path`, нельзя в клиентский бандл) → `ACCEPT_ATTR` недостижим. |
| `LoginInput` | `lib/validation/auth.ts` | Born-unused `z.infer`-тип; логин парсит `loginSchema` инлайн в route, тип-контракт никто не импортировал. |

### Оставлено сознательно

- **Переэкспонированные экспорты** (значение живо внутри файла, лишний `export`):
  `CREDIT_STATUS_VARIANT`/`PAYMENT_STATUS_VARIANT` (constants.ts), `PAYMENT_TYPES`/
  `CREDIT_STATUSES`/`PAYMENT_STATUSES` (validation), `DOCUMENT_FILE_SLOTS` (media-paths),
  `pool` (db/client) — не мёртвый код. Гасятся `ignoreExportsUsedInFile`, не трогаем
  (сужение `export` — косметика без ценности, риск задеть статус-логику).
- **Типы-контракты shared-модулей** (return/input-типы живых функций, потребляются через
  inference): типы сервисов + публичные типы поиска `#035` (`MatchTier`/`FieldHighlight`/
  `RankedMatch` — активно развивается, Ф2/Ф3 впереди). Гасятся `ignoreExportsUsedInFile`.
- **shadcn/ui** — 5 файлов без потребителей на сегодня (`dropdown-menu`, `form`,
  `separator`, `skeleton`, `tabs`) + неиспользуемые сабкомпоненты используемых файлов.
  Библиотечная поверхность, не наш код — `components/ui/**` в `ignore`. Прунить опционально.

### Спящая фича → re-триаж #033 (НЕ удалять молча)

- **`listPayments`** (`lib/services/payments.ts:47`) + тип `PaymentListItem` — готовая
  функция «все платежи пользователя по всем кредитам», но страницы `/payments` нет.
  Born в миграции `27761cc`, ни разу не подключена. Кандидат на достройку (глобальный
  список платежей) **или** удаление — решение владельца. В `PENDING_FOLLOWUPS.md`.
  Остаётся в выхлопе `npm run deadcode` как стоячее напоминание до решения.

### Итог

5 удалений (1 dep + 4 символа), 1 спящая фича в backlog. После чистки `npm run deadcode`
показывает ровно `listPayments` (намеренно) — чистый baseline для месячной дельты.
