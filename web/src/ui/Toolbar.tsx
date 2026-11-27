import { useState } from 'react';
import { useOffice } from '../state/store';
import { ClaudeBanner } from './claudeStatus';
import { notificationPermission, requestNotificationPermission, type Permission } from './notifications';

/** Top-left canvas chrome: `+ Add Project`, `Fit Building`, `📋 Summary`, `🔔` (`notify`, live office only), `☀/🌙`. */
export function Toolbar({ onAdd, onFit, onSummary, notify }: { onAdd?: () => void; onFit: () => void; onSummary?: () => void; notify?: boolean }) {
  const night = useOffice(s => s.night);
  return (
    <div className="po-toolbar" role="toolbar" aria-label="Office">
      {onAdd && <button type="button" className="po-tb" onClick={onAdd}><span className="po-tb-plus">+</span> Add Project</button>}
      <button type="button" className="po-tb" onClick={onFit} title="Frame the whole building">⤢ Fit Building</button>
      {onSummary && <button type="button" className="po-tb" onClick={onSummary} title="What happened since your last visit">📋 Summary</button>}
      {notify && <NotifyButton />}
      <button type="button" className="po-tb po-tb-icon" onClick={() => useOffice.getState().setNight(!night)}
        aria-label={night ? 'Switch to day' : 'Switch to night'} title={night ? 'Night (click for day)' : 'Day (click for night)'}>
        {night ? '🌙' : '☀'}
      </button>
      <ClaudeBanner compact />
    </div>
  );
}

/** 🔔: the first click asks for notification permission; after that it toggles the chime. */
export function NotifyButton() {
  const sound = useOffice(s => s.soundOn);
  const [perm, setPerm] = useState<Permission>(() => notificationPermission());
  const ask = perm === 'default';
  const click = async () => {
    if (ask) { setPerm(await requestNotificationPermission()); return; }
    useOffice.getState().setSound(!sound);
  };
  const status = perm === 'granted' ? 'notifications on' : perm === 'denied' ? 'notifications blocked by the browser' : 'notifications unavailable';
  const label = ask ? 'Enable notifications' : `Sound ${sound ? 'on' : 'off'} (${status}) — click to turn the sound ${sound ? 'off' : 'on'}`;
  return (
    <button type="button" className={`po-tb po-tb-icon${ask ? ' po-tb-ask' : ''}`} aria-label={label} title={label} aria-pressed={ask ? undefined : sound}
      onClick={() => void click()}>
      {ask || sound ? '🔔' : '🔕'}
    </button>
  );
}
