/**
 * Адрес возврата после входа через ЕСА.
 *
 * Берётся из env, а НЕ собирается из заголовка `Host` запроса. Причина прямая:
 * `Host` присылает клиент, и собранный из него redirect_uri — классический
 * host-header injection, то есть код авторизации уехал бы на чужой адрес.
 * Провайдер сверяет redirect_uri со списком, зарегистрированным для клиента,
 * поэтому значение обязано совпадать с зарегистрированным буква-в-букву —
 * включая punycode для кириллического домена.
 *
 * В отслеживаемых файлах значения нет (D-038): оно живёт в env-файле сервиса.
 */
export function esaRedirectUri(): string | null {
  const raw = process.env.ESA_REDIRECT_URI?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // http допустим только локально: код авторизации по открытому каналу
    // означает, что перехватить его может кто угодно по пути.
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
