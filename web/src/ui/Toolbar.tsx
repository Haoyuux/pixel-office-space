import { useOffice } from '../state/store';

/** Top-left canvas chrome: `+ Add Project`, `Fit Building`, `☀/🌙`. */
export function Toolbar({ onAdd, onFit }: { onAdd?: () => void; onFit: () => void }) {
  const night = useOffice(s => s.night);
  return (
    <div className="po-toolbar" role="toolbar" aria-label="Office">
      {onAdd && <button type="button" className="po-tb" onClick={onAdd}><span className="po-tb-plus">+</span> Add Project</button>}
      <button type="button" className="po-tb" onClick={onFit} title="Frame the whole building">⤢ Fit Building</button>
      <button type="button" className="po-tb po-tb-icon" onClick={() => useOffice.getState().setNight(!night)}
        aria-label={night ? 'Switch to day' : 'Switch to night'} title={night ? 'Night (click for day)' : 'Day (click for night)'}>
        {night ? '🌙' : '☀'}
      </button>
    </div>
  );
}
