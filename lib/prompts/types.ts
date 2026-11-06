/**
 * Типы библиотеки промтов.
 *
 * Отдельным файлом — потому что их видит и сервер (сервис), и браузер
 * (панель промтов). Сервис помечен `server-only`, и клиентский компонент не
 * мог бы импортировать типы из него: даже type-only импорт из server-only
 * модуля ломает сборку клиента.
 */

export type PromptSource = 'manual' | 'brain';

export type PromptItem = {
  id: number;
  project: string;
  title: string;
  body: string;
  source: PromptSource;
  /** Когда промт создан (строка Postgres, 'YYYY-MM-DD HH:MM:SS.mmm+00'). */
  createdAt: string;
  /** Когда промт отправили в архив — null у живых. */
  archivedAt: string | null;
};

/** Проекты, в которых есть живые промты: имя раздела и число промтов. */
export type PromptProjectSummary = {
  project: string;
  count: number;
};
