import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hasTopHeading, Markdown, parseMarkdown, safeHref } from '@/lib/markdown';

const SAMPLE = `> **Черновик.** Не действующая
> редакция.

# Оферта

1.1. Продавец [не задано: SELLER_NAME] и ИНН 0000.

## Возврат

- Первый пункт
  с продолжением.
- **Второй** пункт

1. Раз
2. Два

| Цель | Данные |
|---|---|
| Заказ | телефон |
`;

describe('parseMarkdown', () => {
  it('parses the block types used by the legal texts', () => {
    const blocks = parseMarkdown(SAMPLE);
    expect(blocks.map((block) => block.type)).toEqual([
      'quote',
      'heading',
      'paragraph',
      'heading',
      'list',
      'list',
      'table',
    ]);
    expect(blocks[2]).toEqual({
      type: 'paragraph',
      text: '1.1. Продавец [не задано: SELLER_NAME] и ИНН 0000.',
    });
    expect(blocks[4]).toEqual({
      type: 'list',
      ordered: false,
      start: 1,
      items: ['Первый пункт с продолжением.', '**Второй** пункт'],
    });
    expect(blocks[6]).toEqual({
      type: 'table',
      header: ['Цель', 'Данные'],
      rows: [['Заказ', 'телефон']],
    });
    expect(hasTopHeading(SAMPLE)).toBe(true);
    expect(hasTopHeading('## Только второй уровень')).toBe(false);
  });
});

describe('Markdown', () => {
  it('renders escaped HTML and keeps placeholders with underscores intact', () => {
    const html = renderToStaticMarkup(<Markdown source={SAMPLE} />);
    expect(html).toContain(
      '<blockquote><p><strong>Черновик.</strong> Не действующая редакция.</p></blockquote>',
    );
    expect(html).toContain('<h1>Оферта</h1>');
    expect(html).toContain('[не задано: SELLER_NAME]');
    expect(html).toContain('<ol><li>Раз</li><li>Два</li></ol>');
    expect(html).toContain('<td>телефон</td>');
  });

  it('never renders raw HTML or unsafe links', () => {
    const html = renderToStaticMarkup(
      <Markdown source={'<script>alert(1)</script> [x](javascript:alert(1)) [ok](/docs/offer)'} />,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<a href="/docs/offer">ok</a>');
  });

  it('accepts only http(s), mailto, tel and same-site links', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('tel:+7')).toBe('tel:+7');
    expect(safeHref('/returns')).toBe('/returns');
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
  });
});
