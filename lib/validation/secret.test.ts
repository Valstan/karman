import { describe, it, expect } from 'vitest';
import {
  secretPushSchema,
  secretItemUpsertSchema,
  secretTokenCreateSchema,
  secretCardCreateSchema,
  secretCardFieldUpsertSchema,
  secretGrantApiRevokeSchema,
  secretBootstrapCreateSchema,
  passportIdentityCreateSchema,
} from './secret';

describe('secretPushSchema', () => {
  it('валидный набор секретов', () => {
    const r = secretPushSchema.safeParse({ secrets: { DATABASE_URL: 'postgres://x', API_KEY: 'abc' } });
    expect(r.success).toBe(true);
  });

  it('пустой набор → ошибка', () => {
    expect(secretPushSchema.safeParse({ secrets: {} }).success).toBe(false);
  });

  it('некорректное имя ключа → ошибка', () => {
    expect(secretPushSchema.safeParse({ secrets: { '1bad': 'v' } }).success).toBe(false);
    expect(secretPushSchema.safeParse({ secrets: { 'has-dash': 'v' } }).success).toBe(false);
  });

  it('пустое значение → ошибка', () => {
    expect(secretPushSchema.safeParse({ secrets: { OK: '' } }).success).toBe(false);
  });

  it('слишком много ключей (>200) → ошибка', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 201; i++) many[`K${i}`] = 'v';
    expect(secretPushSchema.safeParse({ secrets: many }).success).toBe(false);
  });
});

describe('secretTokenCreateSchema — canWrite', () => {
  it('по умолчанию read-only (canWrite=false)', () => {
    const r = secretTokenCreateSchema.safeParse({ projectId: 1, name: 'ci' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.canWrite).toBe(false);
  });

  it('canWrite=true принимается', () => {
    const r = secretTokenCreateSchema.safeParse({ projectId: 1, name: 'trener', canWrite: true });
    expect(r.success && r.data.canWrite).toBe(true);
  });
});

// canWrite решает, сможет ли предъявитель ПИСАТЬ в комнату с чужими секретами.
// Под `z.coerce.boolean()` лежит `Boolean(v)`, а он считает истиной любую
// непустую строку: выбор «нельзя», приехавший строкой 'false' или '0', молча
// стал бы «можно». Пока поле рисуется галочкой, беды нет — но право доступа не
// должно зависеть от того, чем нарисовано поле.
describe('флаг canWrite: строковое «нет» остаётся «нет»', () => {
  const cases: Array<[unknown, boolean]> = [
    [true, true],
    [false, false],
    ['true', true],
    ['on', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['', false],
    [undefined, false],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      const t = secretTokenCreateSchema.safeParse({ projectId: 1, name: 'ci', canWrite: input });
      expect(t.success && t.data.canWrite).toBe(expected);

      const i = passportIdentityCreateSchema.safeParse({
        issuerId: '1',
        identityValue: '123',
        label: 'Valstan/X',
        projectId: '1',
        canWrite: input,
      });
      expect(i.success && i.data.canWrite).toBe(expected);

      const b = secretBootstrapCreateSchema.safeParse({ projectId: 1, canWrite: input });
      expect(b.success && b.data.canWrite).toBe(expected);
    });
  }
});

describe('secretCardCreateSchema', () => {
  it('карточка с env-обозначением', () => {
    const r = secretCardCreateSchema.safeParse({ projectId: 1, title: 'Ключ ВК', envKey: 'SECRET_KEY_VK' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.envKey).toBe('SECRET_KEY_VK');
  });

  it('пустое envKey → личная карточка (undefined)', () => {
    const r = secretCardCreateSchema.safeParse({ projectId: 1, title: 'Почта', envKey: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.envKey).toBeUndefined();
  });

  it('envKey не в стиле env-переменной → ошибка', () => {
    expect(secretCardCreateSchema.safeParse({ projectId: 1, title: 'X', envKey: 'has-dash' }).success).toBe(false);
  });

  it('пустое наименование → ошибка', () => {
    expect(secretCardCreateSchema.safeParse({ projectId: 1, title: '  ' }).success).toBe(false);
  });
});

describe('secretCardFieldUpsertSchema', () => {
  it('kind по умолчанию text', () => {
    const r = secretCardFieldUpsertSchema.safeParse({ cardId: 1, name: 'Описание', value: 'x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.kind).toBe('text');
  });

  it('длинное значение проходит целиком (100 КБ, без обрезания)', () => {
    const long = 'a'.repeat(100 * 1024);
    const r = secretCardFieldUpsertSchema.safeParse({ cardId: 1, name: 'Сертификат', kind: 'secret', value: long });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.value.length).toBe(long.length);
  });

  it('значение больше 256 КБ → ошибка (анти-abuse кап)', () => {
    const huge = 'a'.repeat(262145);
    expect(secretCardFieldUpsertSchema.safeParse({ cardId: 1, name: 'X', value: huge }).success).toBe(false);
  });

  it('неизвестный kind → ошибка', () => {
    expect(secretCardFieldUpsertSchema.safeParse({ cardId: 1, name: 'X', kind: 'blob', value: 'v' }).success).toBe(false);
  });
});

// D-035: в комнатах лежат приватные SSH-ключи владельца. Многострочное значение —
// классическое место, где ключ ломается молча: одна лишняя нормализация, и PEM
// становится нечитаемым, а узнают об этом на проде при первом ssh. Схема обязана
// пропускать его байт-в-байт.
describe('многострочные значения (SSH-ключи, PEM) — D-035', () => {
  // Перевод строки через fromCharCode, а не escape-последовательностью: так тест
  // читается одинаково при любом мыслимом перекодировании файла.
  const NL = String.fromCharCode(10);
  const PEM = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt',
    'ZWQyNTUxOQAAACBQ8m1sHkGr0hV4bYcGkX0aQ0f2sT9nJq5Zx1cVpKtWvAAAAJjWvvxN',
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join(NL);

  it('PEM проходит через secretItemUpsertSchema без искажений', () => {
    const r = secretItemUpsertSchema.safeParse({ projectId: 1, key: 'SSH_KEY__myprod__PC79', value: PEM });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.value).toBe(PEM);
      // Именно это ломается при .trim() на значении: хвостовой перевод строки,
      // без которого ssh-keygen отказывается читать ключ.
      expect(r.data.value.endsWith(NL)).toBe(true);
      expect(r.data.value.split(NL)).toHaveLength(5);
    }
  });

  it('PEM проходит через машинную запись (secretPushSchema)', () => {
    const r = secretPushSchema.safeParse({ secrets: { SSH_KEY__myprod__PC79: PEM } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.secrets.SSH_KEY__myprod__PC79).toBe(PEM);
  });

  it('конвенция имён D-035 совместима с валидатором ключа', () => {
    // Разделитель — двойное подчёркивание, потому что дефис имя ключа не пропускает.
    expect(secretPushSchema.safeParse({ secrets: { SSH_PUB__myprod__PC79: 'ssh-ed25519 AAAA' } }).success).toBe(true);
    expect(secretPushSchema.safeParse({ secrets: { 'SSH_KEY__my-prod__PC79': 'x' } }).success).toBe(false);
  });

  it('ключ размера RSA-4096 (~3.4 КБ) проходит целиком', () => {
    const body = Array.from({ length: 48 }, () => 'MIIJKQIBAAKCAgEAvQ7hEXAMPLEbase64line0123456789abcdefghijklmnopq').join(NL);
    const big = ['-----BEGIN RSA PRIVATE KEY-----', body, '-----END RSA PRIVATE KEY-----', ''].join(NL);
    expect(big.length).toBeGreaterThan(3000);
    const r = secretItemUpsertSchema.safeParse({ projectId: 1, key: 'SSH_KEY__big__PC79', value: big });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.value).toBe(big);
  });
});

describe('secretGrantApiRevokeSchema', () => {
  it('id приводится к числу и должен быть положительным', () => {
    expect(secretGrantApiRevokeSchema.safeParse({ id: '7' }).success).toBe(true);
    expect(secretGrantApiRevokeSchema.safeParse({ id: 0 }).success).toBe(false);
  });
});

describe('passportIdentityCreateSchema — реестр личностей (веха 2)', () => {
  const valid = {
    issuerId: '1',
    identityValue: '1296082925',
    label: 'Valstan/KazanskayaMalmyzh',
    projectId: '11',
    canWrite: 'on',
    note: 'мандат 03.09',
  };

  it('форма приходит строками — числа и флаг приводятся', () => {
    const r = passportIdentityCreateSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.issuerId).toBe(1);
      expect(r.data.projectId).toBe(11);
      expect(r.data.canWrite).toBe(true);
    }
  });

  it('право записи по умолчанию не выдаётся', () => {
    const { canWrite: _omit, ...noFlag } = valid;
    const r = passportIdentityCreateSchema.safeParse(noFlag);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.canWrite).toBe(false);
  });

  it('комната обязательна — без неё личность повисла бы ни на чём', () => {
    expect(passportIdentityCreateSchema.safeParse({ ...valid, projectId: '' }).success).toBe(false);
    expect(passportIdentityCreateSchema.safeParse({ ...valid, projectId: '0' }).success).toBe(false);
  });

  // Опечатка в идентификаторе не видна сразу: она проявится безмолвным отказом
  // на входе чужого CI, где искать причину будет уже некому.
  it('пробел или кавычка в идентификаторе — отказ', () => {
    expect(passportIdentityCreateSchema.safeParse({ ...valid, identityValue: '129 608' }).success).toBe(false);
    expect(passportIdentityCreateSchema.safeParse({ ...valid, identityValue: "'129'" }).success).toBe(false);
    expect(passportIdentityCreateSchema.safeParse({ ...valid, identityValue: '' }).success).toBe(false);
  });

  it('нецифровой идентификатор допустим — другой издатель нумерует иначе', () => {
    expect(passportIdentityCreateSchema.safeParse({ ...valid, identityValue: 'repo:acme/app' }).success).toBe(true);
  });

  it('метка обязательна: без неё аудит нечитаем', () => {
    expect(passportIdentityCreateSchema.safeParse({ ...valid, label: '   ' }).success).toBe(false);
  });

  it('пустое основание → undefined, а не пустая строка в БД', () => {
    const r = passportIdentityCreateSchema.safeParse({ ...valid, note: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.note).toBeUndefined();
  });
});
