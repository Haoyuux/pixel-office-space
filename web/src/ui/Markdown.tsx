import type { ReactNode } from 'react';

/** Inline spans: `code`, **bold**, *italic*. Anything unmatched stays plain text. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}:${n++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], k)}</strong>);
    else out.push(<em key={k}>{inline(m[3], k)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Tiny safe markdown: paragraphs, #-headings, lists, fenced code, bold/italic/code. Renders React nodes only (no HTML injection). */
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
    if (/^\s*```/.test(l)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(<pre key={`c${out.length}`}>{code.join('\n')}</pre>);
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
