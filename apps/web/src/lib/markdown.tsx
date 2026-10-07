/**
 * Minimal Markdown renderer for the legal texts in `document_versions` (our own content, but
 * rendered without dangerouslySetInnerHTML anyway: every string goes through React escaping).
 *
 * Supported: ATX headings, paragraphs, blockquotes (nested Markdown), flat ordered and
 * unordered lists with continuation lines, pipe tables, horizontal rules; inline **bold**,
 * *italic*, `code` and [links](url) with http(s), mailto, tel or same-site URLs.
 * `_underscores_` are not emphasis on purpose: env placeholders contain them.
 */
import { Fragment, type ReactNode } from 'react';

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'hr' };

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const UL_RE = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_RE = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    HEADING_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    QUOTE_RE.test(line) ||
    HR_RE.test(line) ||
    (line.trim().startsWith('|') && next !== undefined && TABLE_SEP_RE.test(next))
  );
}

/** Plain-text column header for data-label: inline markers removed. */
function headerLabel(cell: string | undefined): string {
  return (cell ?? '').replace(/\*\*|`/g, '').trim();
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, text: heading[2] ?? '' });
      i += 1;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i] as string)) {
        inner.push((QUOTE_RE.exec(lines[i] as string) as RegExpExecArray)[1] ?? '');
        i += 1;
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(inner.join('\n')) });
      continue;
    }
    if (line.trim().startsWith('|') && TABLE_SEP_RE.test(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).trim().startsWith('|')) {
        rows.push(splitRow(lines[i] as string));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const ordered = !ul;
      const markerRe = ordered ? OL_RE : UL_RE;
      const items: string[] = [];
      const start = ol ? Number(ol[1]) : 1;
      while (i < lines.length) {
        const current = lines[i] as string;
        const match = markerRe.exec(current);
        if (match) {
          items.push((ordered ? match[2] : match[1]) ?? '');
          i += 1;
          continue;
        }
        if (isBlank(current)) {
          // A blank line ends the list unless the next line continues it.
          const next = lines[i + 1];
          if (next !== undefined && markerRe.test(next)) {
            i += 1;
            continue;
          }
          break;
        }
        if (startsBlock(current, lines[i + 1])) break;
        // Continuation (indented or lazy) of the last item.
        items[items.length - 1] = `${items[items.length - 1] ?? ''} ${current.trim()}`;
        i += 1;
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }
    const text: string[] = [];
    while (i < lines.length) {
      const current = lines[i] as string;
      if (isBlank(current) || (text.length > 0 && startsBlock(current, lines[i + 1]))) break;
      text.push(current.trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: text.join(' ') });
  }
  return blocks;
}

const INLINE_RE =
  /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![*\w])\*(?!\s)([^*]+?)\*(?![*\w])/gu;

export function safeHref(url: string): string | null {
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (url.startsWith('#')) return url;
  return null;
}

export function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index;
    if (index > last) nodes.push(text.slice(last, index));
    const [, bold, code, linkText, linkUrl, em] = match;
    if (bold !== undefined) {
      nodes.push(<strong key={key++}>{renderInline(bold)}</strong>);
    } else if (code !== undefined) {
      nodes.push(<code key={key++}>{code}</code>);
    } else if (linkText !== undefined && linkUrl !== undefined) {
      const href = safeHref(linkUrl);
      nodes.push(
        href ? (
          <a key={key++} href={href}>
            {renderInline(linkText)}
          </a>
        ) : (
          <Fragment key={key++}>{renderInline(linkText)}</Fragment>
        ),
      );
    } else if (em !== undefined) {
      nodes.push(<em key={key++}>{renderInline(em)}</em>);
    }
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}` as const;
      return <Tag key={key}>{renderInline(block.text)}</Tag>;
    }
    case 'paragraph':
      return <p key={key}>{renderInline(block.text)}</p>;
    case 'quote':
      return <blockquote key={key}>{block.blocks.map(renderBlock)}</blockquote>;
    case 'list':
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div key={key} className="table-scroll">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} scope="col">
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    // data-label: the column header shown before the cell when a narrow
                    // screen stacks the table into cards (globals.css, .legal td::before).
                    <td key={index} data-label={headerLabel(block.header[index])}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr key={key} />;
  }
}

/** Anchor id of the n-th (1-based) heading of the anchored level: «section-3». */
export function headingAnchorId(n: number): string {
  return `section-${n}`;
}

/** Heading text without the inline markers («**», «`», link brackets), for a table of contents. */
function plainInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/(?<![*\w])\*(?!\s)([^*]+?)\*(?![*\w])/gu, '$1')
    .trim();
}

/**
 * The headings of one level as anchors (id and plain text), in order: the table of contents of
 * a legal document. Pairs with `<Markdown anchorLevel>`, which gives the same headings the same
 * ids. Top-level only: headings inside quotes are not counted on either side.
 */
export function headingAnchors(source: string, level: 2 | 3 = 2): { id: string; text: string }[] {
  return parseMarkdown(source)
    .filter((block) => block.type === 'heading' && block.level === level)
    .map((block, index) => ({
      id: headingAnchorId(index + 1),
      text: plainInline((block as { text: string }).text),
    }));
}

export function Markdown({
  source,
  className,
  anchorLevel,
}: {
  source: string;
  className?: string;
  /** Give the top-level headings of this level ids (headingAnchors) for a table of contents. */
  anchorLevel?: 2 | 3;
}) {
  let n = 0;
  return (
    <div className={className}>
      {parseMarkdown(source).map((block, key) => {
        if (anchorLevel && block.type === 'heading' && block.level === anchorLevel) {
          n += 1;
          const Tag = `h${block.level}` as const;
          return (
            <Tag key={key} id={headingAnchorId(n)}>
              {renderInline(block.text)}
            </Tag>
          );
        }
        return renderBlock(block, key);
      })}
    </div>
  );
}

/** True when the document body starts its own top-level heading. */
export function hasTopHeading(source: string): boolean {
  return parseMarkdown(source).some((block) => block.type === 'heading' && block.level === 1);
}
