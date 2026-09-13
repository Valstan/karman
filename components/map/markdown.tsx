import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Рендер Markdown вкладок карты (D-090). Только безопасный путь: `react-markdown`
 * строит React-элементы из синтаксического дерева, а `skipHtml` отбрасывает raw HTML
 * из файла целиком — ни в разметку, ни в текст он не попадает. Никакого
 * `dangerouslySetInnerHTML`. `remark-gfm` — ради таблиц и зачёркивания, на которых
 * держится вкладка «Серверы».
 *
 * Стили заданы на элементах, а не плагином типографики: таблицы обязаны прокручиваться
 * по горизонтали на телефоне, не ломая ширину страницы.
 */
export function MapMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

type C<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T>;

const components: ComponentProps<typeof ReactMarkdown>['components'] = {
  h1: ({ children }: C<'h1'>) => <h2 className="mt-2 text-xl font-semibold">{children}</h2>,
  h2: ({ children }: C<'h2'>) => (
    <h3 className="mt-4 border-b pb-1 text-lg font-semibold">{children}</h3>
  ),
  h3: ({ children }: C<'h3'>) => <h4 className="mt-3 text-base font-semibold">{children}</h4>,
  p: ({ children }: C<'p'>) => <p>{children}</p>,
  ul: ({ children }: C<'ul'>) => <ul className="list-disc space-y-1 pl-6">{children}</ul>,
  ol: ({ children }: C<'ol'>) => <ol className="list-decimal space-y-1 pl-6">{children}</ol>,
  a: ({ href, children }: C<'a'>) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 break-all"
    >
      {children}
    </a>
  ),
  code: ({ children }: C<'code'>) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }: C<'pre'>) => (
    <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{children}</pre>
  ),
  blockquote: ({ children }: C<'blockquote'>) => (
    <blockquote className="border-l-4 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-2" />,
  table: ({ children }: C<'table'>) => (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[40rem] text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: C<'thead'>) => <thead className="bg-muted/60">{children}</thead>,
  th: ({ children }: C<'th'>) => (
    <th className="px-3 py-2 text-left align-top font-medium whitespace-nowrap">{children}</th>
  ),
  td: ({ children }: C<'td'>) => <td className="border-t px-3 py-2 align-top">{children}</td>,
  del: ({ children }: C<'del'>) => <del className="text-muted-foreground">{children}</del>,
};
