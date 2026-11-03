/**
 * Разбор списка аккаунтов для массового импорта (чистый модуль, без БД).
 *
 * Формат строки: `почта|пароль|название` (разделитель — «|»). Название
 * необязательно: по умолчанию берётся ИМЯ ЯЩИКА — часть до «@»
 * (решение владельца 03.11: «названия аккаунтов возьми названия ящиков»).
 * Пустые строки и строки с «#» пропускаются.
 */

export type ParsedImportItem = {
  email: string;
  password: string;
  title?: string;
};

export type ParsedImport = {
  items: ParsedImportItem[];
  /** Строки, которые разобрать не удалось (с номером строки). */
  errors: string[];
};

/** Имя ящика = часть адреса до «@» — становится названием аккаунта. */
export function defaultAccountTitle(email: string): string {
  const [local] = email.split('@');
  return (local ?? email).trim();
}

/**
 * Разбирает многострочный список аккаунтов.
 *
 * Ошибки не роняют весь импорт: плохие строки собираются отдельно, хорошие
 * импортируются. Иначе одна опечатка в пятидесяти строках оставила бы вас
 * с пустым разделом и без объяснения, что именно не так.
 */
export function parseAccountImport(text: string): ParsedImport {
  const items: ParsedImportItem[] = [];
  const errors: string[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;

    const parts = line.split('|').map((part) => part.trim());
    const email = parts[0] ?? '';
    const password = parts[1] ?? '';
    const title = parts[2] ?? '';

    if (!email || !password) {
      errors.push(`строка ${index + 1}: нужны почта и пароль (почта|пароль|название)`);
      return;
    }
    if (!email.includes('@') || email.endsWith('@')) {
      errors.push(`строка ${index + 1}: «${email}» — не похоже на почту`);
      return;
    }
    items.push({
      email,
      password,
      ...(title ? { title } : {}),
    });
  });

  return { items, errors };
}
