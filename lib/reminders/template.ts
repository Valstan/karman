/**
 * Подстановка переменных в шаблон тела/заголовка напоминания: {ключ} → значение.
 * Неизвестные плейсхолдеры остаются как есть. Чистая функция (Unicode-ключи:
 * {сумма}, {дней}…) — тестируется.
 */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/gu, (match, key: string) =>
    vars[key] !== undefined ? vars[key] : match,
  );
}
