import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton';
import { highlight, langOf } from './highlight';

/** Only these schemes become links (never javascript: or data:). */
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;
const Link = ({ href, children }: { href: string; children: ReactNode }) =>
  <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;

/** Inline spans: `code`, [text](url), bare https:// links, **bold**, *italic*. Anything unmatched stays plain text. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}:${n++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[3] !== undefined && SAFE_URL.test(m[3])) out.push(<Link key={k} href={m[3]}>{inline(m[2], k)}</Link>);
    else if (m[4] !== undefined) out.push(<Link key={k} href={m[4]}>{m[4]}</Link>);
    else if (m[5] !== undefined) out.push(<strong key={k}>{inline(m[5], k)}</strong>);
    else out.push(<em key={k}>{inline(m[6], k)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A fenced code block: language label, copy button, highlighted tokens (text spans only). */
export function CodeBlock({ code, info = '' }: { code: string; info?: string }) {
  const lang = langOf(info);
  return (
    <div className="po-code">
      <div className="po-code-head">
        <span className="po-code-lang">{info.trim().split(/\s+/)[0] || 'text'}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      <pre><code>{highlight(code, lang).map((t, i) => (t.cls ? <span key={i} className={`po-tok-${t.cls}`}>{t.text}</span> : t.text))}</code></pre>
    </div>
  );
}

/** `| a | b |` → its cells (escaped `\|` stays in a cell). */
const cells = (row: string) => {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
};
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l) || (/\|/.test(l) && !/^\s*$/.test(l));
type Align = 'left' | 'right' | 'center' | undefined;

/** Tiny safe markdown: paragraphs, #-headings, lists, tables, links, fenced code, bold/italic/code. Renders React nodes only (no HTML injection). */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushList = () => {
    if (!list) return;
    const k = `l${out.length}`;
    const items = list.items.map((t, i) => <li key={i}>{inline(t, `${k}:${i}`)}</li>);
    out.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
    list = null;
  };
  const flushPara = () => {
    if (!para.length) return;
    const k = `p${out.length}`;
    out.push(<p key={k}>{para.flatMap((l, i) => (i ? [<br key={`${k}:b${i}`} />, ...inline(l, `${k}:${i}`)] : inline(l, `${k}:${i}`)))}</p>);
    para = [];
  };
  const flush = () => { flushPara(); flushList(); };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = /^\s*```(.*)$/.exec(l);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(<CodeBlock key={`c${out.length}`} code={code.join('\n')} info={fence[1]} />);
      continue;
    }
    // a table: a header row, then a |---|:--:| separator row
    if (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const head = cells(l);
      const align: Align[] = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined));
      const body: string[][] = [];
      i += 1;
      while (i + 1 < lines.length && lines[i + 1].trim() && isRow(lines[i + 1])) body.push(cells(lines[++i]));
      const k = `t${out.length}`;
      out.push(
        <div key={k} className="po-table-wrap"><table className="po-table">
          <thead><tr>{head.map((c, j) => <th key={j} style={{ textAlign: align[j] }}>{inline(c, `${k}:h${j}`)}</th>)}</tr></thead>
          <tbody>{body.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j} style={{ textAlign: align[j] }}>{inline(r[j] ?? '', `${k}:${ri}:${j}`)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    const li = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/.exec(l);
    if (h) { flush(); out.push(<h4 key={`h${out.length}`} className={`po-h${h[1].length}`}>{inline(h[2], `h${i}`)}</h4>); }
    else if (li) {
      flushPara();
      const ordered = !li[1];
      if (list && list.ordered !== ordered) flushList();
      (list ??= { ordered, items: [] }).items.push(li[3]);
    } else if (!l.trim()) flush();
    else { flushList(); para.push(l); }
  }
  flush();
  return <div className={`po-md ${className}`.trim()}>{out}</div>;
}
