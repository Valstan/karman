/**
 * Копирует .next/static и public внутрь .next/standalone, чтобы standalone-сервер
 * (`node .next/standalone/server.js`) отдавал статику и публичные файлы.
 *
 * Кросс-платформенно (Node fs) — для локального прод-смоук-теста через `npm run start`.
 * На проде то же самое делает scripts/deploy.sh (cp -r) перед `systemctl restart`.
 */
import { cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const STANDALONE = '.next/standalone';

async function main() {
  if (!existsSync(STANDALONE)) {
    throw new Error(
      'Нет .next/standalone — сначала `npm run build` (нужен output: "standalone").',
    );
  }

  // .next/static → .next/standalone/.next/static
  await rm(`${STANDALONE}/.next/static`, { recursive: true, force: true });
  await cp('.next/static', `${STANDALONE}/.next/static`, { recursive: true });

  // public → .next/standalone/public (каталога может не быть)
  if (existsSync('public')) {
    await rm(`${STANDALONE}/public`, { recursive: true, force: true });
    await cp('public', `${STANDALONE}/public`, { recursive: true });
  }
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
