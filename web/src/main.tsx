import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Errors are surfaced in #err so the screenshot script (tools/shot.mjs) can report them.
const report = (m: string) => { const el = document.getElementById('err'); if (el) el.textContent += m + '\n'; };
window.addEventListener('error', e => report(String(e.message)));
window.addEventListener('unhandledrejection', e => report(String((e.reason as Error)?.stack ?? e.reason)));

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
