import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MapMarkdown } from './markdown';

describe('MapMarkdown — безопасный рендер вкладок карты (D-090)', () => {
  it('raw HTML из файла отбрасывается, не вставляется в страницу', () => {
    const html = renderToStaticMarkup(
      <MapMarkdown markdown={'# Планы\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nтекст'} />,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert');
    expect(html).toContain('текст');
  });

  it('GFM-таблица и зачёркивание рендерятся, таблица в прокручиваемой обёртке', () => {
    const md = [
      '## Бокс 1',
      '',
      '| Проект | Порт |',
      '|---|---|',
      '| КАРМАН | :3002 |',
      '| ~~Калинино~~ | :3006 |',
    ].join('\n');
    const html = renderToStaticMarkup(<MapMarkdown markdown={md} />);
    expect(html).toContain('overflow-x-auto');
    expect(html).toMatch(/<th[^>]*>Проект<\/th>/);
    expect(html).toMatch(/<td[^>]*>:3002<\/td>/);
    expect(html).toMatch(/<del[^>]*>Калинино<\/del>/);
  });

  it('ссылки открываются в новой вкладке без referrer', () => {
    const html = renderToStaticMarkup(<MapMarkdown markdown={'[сайт](https://example.org/)'} />);
    expect(html).toContain('href="https://example.org/"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
