import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    environment: 'node',
    // Ревизия гейтов #104 (2026-08-03): было `lib/**/*.test.ts` — тест, положенный
    // в app/ или components/, а равно `.test.tsx` внутри lib/, молча НЕ запускался,
    // и гейт при этом оставался зелёным (проверено заведомо падающими тестами).
    // Ищем по всему репозиторию; исключаем сборочные артефакты, иначе в прогон
    // попадают копии тестов из .next/standalone.
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**', 'releases/**'],
  },
});
