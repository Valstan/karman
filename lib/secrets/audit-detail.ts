/**
 * Тексты `detail` строк аудита, у которых есть формат, а не свободная фраза.
 * Чистый модуль (без `server-only`): используется в сервисе и в тестах.
 */

/**
 * `project_deleted` — строка с `project_id = NULL`, переживающая каскад удаления
 * комнаты. Числа — то, что каскад уничтожил: следующий вопрос «сколько там было»
 * (D-078) отвечается из БД, а не по памяти владельца. Формат `k=v` через пробел,
 * как у остальных machine-readable detail (`key=…`).
 */
export function projectDeletedDetail(
  slug: string,
  n: { audit: number; tokens: number; items: number },
): string {
  return `slug=${slug} audit=${n.audit} tokens=${n.tokens} items=${n.items}`;
}
