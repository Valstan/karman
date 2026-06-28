/**
 * Next.js instrumentation: однократно при старте серверного инстанса.
 * Используется для fail-fast валидации обязательного окружения в production —
 * сервис намеренно не стартует без SESSION_SECRET.
 *
 * Важно: пропускаем фазу сборки (`next build` → NEXT_PHASE='phase-production-build'),
 * иначе проверка ломала бы сборку прод-артефакта, у которого ещё нет рантайм-секрета.
 * Сам ключ резолвится лениво в lib/auth/jwt.ts — здесь только ранний громкий отказ.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return;
  }
  if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be set in production');
  }
  // Мягкое предупреждение (не throw — ядро приложения не зависит от напоминаний):
  // без секрета эндпоинты /api/telegram/ingest и /api/reminders/dispatch отдают 401.
  if (process.env.NODE_ENV === 'production' && !process.env.REMINDERS_INTERNAL_SECRET) {
    console.warn(
      '[reminders] REMINDERS_INTERNAL_SECRET не задан — Telegram-напоминания отключены (эндпоинты вернут 401).',
    );
  }
  // Менеджер секретов опционален: без мастер-ключа страница /secrets и /api/secrets
  // работают частично (создание проектов да, шифрование/выдача — нет). Мягкое предупреждение.
  if (process.env.NODE_ENV === 'production' && !process.env.SECRETS_MASTER_KEY) {
    console.warn(
      '[secrets] SECRETS_MASTER_KEY не задан — менеджер секретов отключён (шифрование/выдача недоступны).',
    );
  }
}
