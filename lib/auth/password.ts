import crypto from 'node:crypto';

/**
 * Проверка пароля в формате Django (`<algo>$<iterations>$<salt>$<base64 digest>`).
 * Портировано 1:1 из старого Express-API, чтобы существующие хеши auth_user
 * продолжали работать без сброса паролей.
 *
 * ВНИМАНИЕ: только Node runtime (crypto.pbkdf2Sync недоступен в Edge).
 */
function safeEqualStrings(left: string, right: string): boolean {
  const leftDigest = crypto.createHash('sha256').update(left).digest();
  const rightDigest = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

export function verifyDjangoPassword(rawPassword: string, encodedPassword: string | null): boolean {
  if (!encodedPassword || encodedPassword.startsWith('!')) {
    return false;
  }

  const parts = encodedPassword.split('$');
  if (parts.length !== 4) {
    return false;
  }

  const [algorithm, iterationsRaw, salt, digest] = parts as [string, string, string, string];
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 1) {
    return false;
  }

  if (algorithm === 'pbkdf2_sha256') {
    const calculated = crypto.pbkdf2Sync(rawPassword, salt, iterations, 32, 'sha256').toString('base64');
    return safeEqualStrings(calculated, digest);
  }

  if (algorithm === 'pbkdf2_sha1') {
    const calculated = crypto.pbkdf2Sync(rawPassword, salt, iterations, 20, 'sha1').toString('base64');
    return safeEqualStrings(calculated, digest);
  }

  return false;
}

/**
 * Хеширование пароля в формате Django `pbkdf2_sha256` (для сидов и будущего
 * управления пользователями). Совместимо с verifyDjangoPassword.
 */
export function hashDjangoPassword(rawPassword: string, iterations = 600000): string {
  const salt = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  const digest = crypto.pbkdf2Sync(rawPassword, salt, iterations, 32, 'sha256').toString('base64');
  return `pbkdf2_sha256$${iterations}$${salt}$${digest}`;
}
