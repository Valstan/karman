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
}
