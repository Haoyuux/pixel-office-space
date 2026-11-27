import { useEffect, useRef, useState } from 'react';

/** Copies text to the clipboard (falls back to a hidden textarea where the Clipboard API is missing). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  } catch { return false; }
}

/** ⧉ Copy → ✓ Copied for a moment. */
export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState<null | boolean>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(text);
    setDone(ok);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(null), 1500);
  };
  return (
    <button type="button" className={`po-copy${done ? ' done' : ''} ${className}`.trim()} aria-label={label} title={label}
      onClick={() => void copy()}>
      {done === null ? '⧉' : done ? '✓ Copied' : 'Copy failed'}
    </button>
  );
}
