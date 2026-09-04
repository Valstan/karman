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

/**
 * Может ли человек вообще войти паролем.
 *
 * Не «пароль не пустой»: отказов у `verifyDjangoPassword` шире — непригодный
 * хэш с `!`, неверное число частей, незнакомый алгоритм, нецелые итерации.
 * Хэши в `auth_user` достались от старой системы и нами не контролировались,
 * поэтому предикат обязан быть тем же САМЫМ, а не похожим: на нём стоит защита
 * от запирания при отвязке ЕСА, и «похожий» предикат разрешил бы отвязку тому,
 * кого пароль на самом деле уже не пускает.
 */
export function hasUsablePassword(encodedPassword: string | null): boolean {
  return parseDjangoHash(encodedPassword) !== null;
}

type DjangoHash = { algorithm: string; iterations: number; salt: string; digest: string };

function parseDjangoHash(encodedPassword: string | null): DjangoHash | null {
  if (!encodedPassword || encodedPassword.startsWith('!')) return null;
  const parts = encodedPassword.split('$');
  if (parts.length !== 4) return null;
  const [algorithm, iterationsRaw, salt, digest] = parts as [string, string, string, string];
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  if (algorithm !== 'pbkdf2_sha256' && algorithm !== 'pbkdf2_sha1') return null;
  return { algorithm, iterations, salt, digest };
}

export function verifyDjangoPassword(rawPassword: string, encodedPassword: string | null): boolean {
  const parsed = parseDjangoHash(encodedPassword);
  if (!parsed) {
    return false;
  }
  const { algorithm, iterations, salt, digest } = parsed;

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
