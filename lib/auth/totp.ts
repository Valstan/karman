import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';

/**
 * TOTP (RFC 6238) и recovery-коды — второй фактор входа (vault Ф2).
 * Чистый модуль (без `server-only`) — юнит-тестируется. Крипта — otplib v13
 * (@noble/hashes + @scure/base, аудированные), не самописная. Секрет TOTP
 * шифруется мастер-ключом на слое сервиса.
 */

// Терпимость ±30 с — рассинхрон часов телефона на один TOTP-шаг.
const EPOCH_TOLERANCE_S = 30;

const ISSUER = 'KARMAN';
const RECOVERY_COUNT = 10;

/** Новый base32-секрет TOTP (для enrollment). */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** otpauth:// URI для QR-кода (Google Authenticator / Aegis / …). */
export function totpKeyUri(username: string, secret: string): string {
  return generateURI({ issuer: ISSUER, label: username, secret });
}

/** Проверка 6-значного кода против секрета (окно ±30 с). */
export function verifyTotpCode(code: string, secret: string): boolean {
  try {
    return verifySync({
      token: code.replace(/\s+/g, ''),
      secret,
      epochTolerance: EPOCH_TOLERANCE_S,
    }).valid;
  } catch {
    return false;
  }
}

/** AAD шифрования TOTP-секрета — привязка к пользователю. */
export function totpAad(userId: number): string {
  return `totp:${userId}`;
}

/**
 * Хэш recovery-кода (в БД только он).
 *
 * ## Почему не SHA-256 (аудит #057 S2)
 *
 * Старая редакция была `sha256(normalize(code))` — без соли и без раундов, при алфавите из 31
 * символа и 10 байтах, то есть ~49,5 бита на код. Офлайн-перебор по дампу `auth_recovery_code`
 * находил один из десяти кодов за десятки минут на GPU.
 *
 * Теперь это pbkdf2-sha256 с индивидуальной солью на строку и 600k итераций — столько же,
 * сколько у паролей (`hashDjangoPassword`). Разница в том, что дамп больше не даёт проверочных
 * значений: считать их стоит пароль роли, а он в дампе не лежит.
 *
 * ## Совместимость
 *
 * Старые строки лежат без соли и проверяются по-прежнему, через легаси-ветку. Убрать её можно
 * только после того, как владелец перевыдаст коды: пока ветка жива, сохраняется и асимметрия,
 * для которой миграция и делалась.
 */
export const RECOVERY_KDF_ITERATIONS = 600_000;

export function hashRecoveryCode(code: string, salt?: string | null): string {
  const normalized = normalizeRecoveryCode(code);
  if (!salt) {
    // Легаси-строка: соли нет, и KDF её не изменит (иначе старый код перестал бы работать).
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
  }
  return pbkdf2Sync(normalized, salt, RECOVERY_KDF_ITERATIONS, 32, 'sha256').toString('hex');
}

/** Соль для новой строки recovery-кода. */
export function newRecoverySalt(): string {
  return randomBytes(16).toString('hex');
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[\s-]/g, '');
}

/**
 * Похож ли ввод на recovery-код (а не 6-значный TOTP).
 *
 * Принимаются оба формата: новый (20 символов после нормализации) и старый (10) — иначе
 * перевыданные коды работали бы, а ещё не перевыданные перестали бы, то есть переезд был бы
 * невозможен по частям.
 */
export function looksLikeRecoveryCode(input: string): boolean {
  const length = normalizeRecoveryCode(input).length;
  return length === RECOVERY_CODE_LENGTH || length === LEGACY_RECOVERY_CODE_LENGTH;
}

/**
 * Набор одноразовых recovery-кодов: 20 символов из 32-символьного алфавита (100 бит),
 * группами по пять через дефис — читается вслух и вводится с телефона без запинки.
 *
 * Прежний формат давал ~49,5 бита (31 символ × 10 байт). Разница в цене офлайн-перебора: 49,5
 * бита — десятки минут на GPU, 100 бит — годы.
 *
 * Выборка без смещения: прежний код брал `alphabet[b % 31]`, а 256 % 31 ≠ 0, то есть часть
 * алфавита выпадала чаще. Здесь 32 — степень двойки, поэтому `b & 31` одинаков для всех байт.
 */
export const RECOVERY_CODE_LENGTH = 20;
const LEGACY_RECOVERY_CODE_LENGTH = 10;

/**
 * Равномерный индекс из алфавита без смещения.
 *
 * Две ловушки, и обе уже были в проекте. Первая: `256 % 31` не ноль, поэтому `b % 31` выдаёт
 * первые восемь букв заметно чаще — это срезает энтропию сверх заявленной. Вторая, наша же:
 * `b & 31` для «32 символов» выглядит честно, но алфавит без `i/l/o/0/1` содержит 31 символ,
 * а не 32, и часть байт давала индекс 31 — то есть код выходил на символ короче. Здесь байты
 * из хвоста (>= 248 = 31*8) отбрасываются: каждый символ выпадает с одинаковой вероятностью,
 * длина кода фиксирована.
 */
function randomCharIndex(alphabetLength: number, bytes: Buffer, offset: number): number {
  const limit = 256 - (256 % alphabetLength);
  const byte = bytes[offset] ?? 0;
  return byte < limit ? byte % alphabetLength : -1;
}

export function generateRecoveryCodes(count = RECOVERY_COUNT): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // без i/l/o/0/1 - 31 символ
  const codes: string[] = [];
  while (codes.length < count) {
    // С запасом: часть байт отбрасывается, и длина все равно должна выйти ровно.
    const bytes = randomBytes(RECOVERY_CODE_LENGTH * 2);
    let chars = '';
    for (let i = 0; i < bytes.length && chars.length < RECOVERY_CODE_LENGTH; i += 1) {
      const index = randomCharIndex(alphabet.length, bytes, i);
      if (index >= 0) chars += alphabet[index];
    }
    if (chars.length !== RECOVERY_CODE_LENGTH) continue;
    codes.push([0, 5, 10, 15].map((i) => chars.slice(i, i + 5)).join('-'));
  }
  return codes;
}
