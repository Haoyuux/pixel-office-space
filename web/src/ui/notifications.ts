import type { ServerEvent, Ticket } from '@office/shared';
import { useOffice, type OfficeState } from '../state/store';
import { onServerEvent } from '../state/socket';
import { rootOf } from './threads';
import { ticketKind } from './format';

/**
 * Notifications (M3 §1): a browser notification and a soft chime when a conversation needs the owner (a gate opened)
 * or has news (answer ready, change done, failed). Nothing while that conversation is the one on screen. The tab
 * title counts the items not looked at yet.
 */

export interface Alert { key: string; projectId: string; rootId: string; ticketId: string; title: string; body: string }

export const APP_TITLE = 'Pixel Office';

/** The alert an event raises (null for every other event). `s` is the store state after the event was applied. */
export function alertFor(e: ServerEvent, s: Pick<OfficeState, 'projects' | 'tickets'>): Alert | null {
  if (!('ticketId' in e) || !('seq' in e)) return null;
  const t: Ticket | undefined = s.tickets[e.ticketId];
  const project = s.projects[e.projectId];
  if (!project) return null;
  let what: string;
  switch (e.type) {
    case 'gate.open': what = 'needs your approval'; break;
    case 'ticket.answered': what = 'answer ready'; break;
    // a chat's done follows its answer (already announced); a stopped run was the owner's own doing
    case 'ticket.done': if (e.stopped || !t || ticketKind(t) !== 'ticket') return null; what = 'done'; break;
    case 'ticket.failed': what = `failed — ${e.reason}`; break;
    default: return null;
  }
  return {
    key: `${e.ticketId}:${e.seq}`, projectId: e.projectId, rootId: rootOf(e.ticketId, s.tickets), ticketId: e.ticketId,
    title: `${project.name}: ${what}`, body: t?.title ?? '',
  };
}

/** `(N) Pixel Office` while N items are unseen. */
export const tabTitle = (n: number) => (n > 0 ? `(${n}) ${APP_TITLE}` : APP_TITLE);

export type Permission = NotificationPermission | 'unsupported';

/** Browser access (tests inject a fake). */
export interface NotifyEnv {
  visible(): boolean;
  permission(): Permission;
  show(title: string, body: string, onClick: () => void): void;
  chime(): void;
  setTitle(title: string): void;
  focus(): void;
  /** Calls `fn` when the page becomes visible/hidden; returns an unsubscribe function. */
  onVisibility(fn: () => void): () => void;
}

/** Listens to live events: notifies, chimes and counts unseen items; clears them once that conversation is viewed. */
export function startNotifications(env: NotifyEnv = browserEnv()): () => void {
  const viewing = (rootId: string) => env.visible() && useOffice.getState().openConv?.rootId === rootId;
  const off = onServerEvent(e => {
    const s = useOffice.getState();
    const a = alertFor(e, s);
    if (!a || viewing(a.rootId)) return;
    s.addUnseen({ key: a.key, projectId: a.projectId, rootId: a.rootId });
    if (env.permission() === 'granted') {
      env.show(a.title, a.body, () => { env.focus(); useOffice.getState().openConversation(a.projectId, a.rootId); });
    }
    if (s.soundOn) env.chime();
  });
  const seen = () => {
    const s = useOffice.getState();
    if (s.openConv && env.visible()) s.clearUnseen(s.openConv.rootId);
  };
  let shown = -1;
  const title = (n: number) => { if (n !== shown) { shown = n; env.setTitle(tabTitle(n)); } };
  title(useOffice.getState().unseen.length);
  const unsub = useOffice.subscribe((s, prev) => {
    if (s.openConv !== prev.openConv) seen();
    if (s.unseen !== prev.unseen) title(s.unseen.length);
  });
  const offVis = env.onVisibility(seen);
  return () => { off(); unsub(); offVis(); };
}

// ------------------------------------------------------------------------------------------------

const hasNotification = () => typeof Notification !== 'undefined';

export function notificationPermission(): Permission {
  try { return hasNotification() ? Notification.permission : 'unsupported'; } catch { return 'unsupported'; }
}

export async function requestNotificationPermission(): Promise<Permission> {
  try { return hasNotification() ? await Notification.requestPermission() : 'unsupported'; } catch { return notificationPermission(); }
}

let audio: AudioContext | null = null;

/** A short, soft two-note chime (WebAudio, no asset file). Best effort: silent when audio is unavailable. */
export function chime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    const ctx = audio, t0 = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      const at = t0 + i * 0.12;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.5);
    }
  } catch { /* no audio */ }
}

export function browserEnv(): NotifyEnv {
  return {
    visible: () => document.visibilityState === 'visible',
    permission: notificationPermission,
    show(title, body, onClick) {
      try {
        const n = new Notification(title, { body });
        n.onclick = () => { onClick(); n.close(); };
      } catch { /* blocked */ }
    },
    chime,
    setTitle: t => { document.title = t; },
    focus: () => { try { window.focus(); } catch { /* ignore */ } },
    onVisibility(fn) {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
  };
}
