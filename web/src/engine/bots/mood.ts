/**
 * Moods (M3 §4): a small pure state per bot, fed by the ticket director. happy after its ticket is done / answered,
 * grumpy after a review / QA bounce on its work, tired after more than TIRED_MS of work in one ticket stint. A mood
 * decays back to neutral after MOOD_MS. Time is injected.
 */
import { roleDef, type RoleId } from '@office/shared';
import type { Personality } from './personality';

export type Mood = 'neutral' | 'happy' | 'grumpy' | 'tired';
export type Emote = '😄' | '😤' | '😮‍💨';

/** Hover label face per mood. */
export const MOOD_FACE: Record<Mood, string> = { neutral: '😊', happy: '😄', grumpy: '😤', tired: '😮‍💨' };
export const MOOD_EMOTE: Record<Exclude<Mood, 'neutral'>, Emote> = { happy: '😄', grumpy: '😤', tired: '😮‍💨' };
export const EMOTES: readonly string[] = Object.values(MOOD_EMOTE);
export const isEmote = (k: string | null | undefined): k is Emote => !!k && EMOTES.includes(k);

/** Hover label: "Clara · QA Engineer · coffee lover · 😊". */
export const botLabel = (character: string, role: RoleId, personality: Personality | undefined, mood: Mood) =>
  [character, roleDef(role).label, personality?.label, MOOD_FACE[mood]].filter(Boolean).join(' · ');

export const MOOD_MS = 5 * 60_000;
export const TIRED_MS = 10 * 60_000;

export class Moods {
  private moods = new Map<string, { mood: Mood; at: number }>();
  /** Work done in the current duty stint (ms), and since when the bot is working right now. */
  private work = new Map<string, { acc: number; since: number | null }>();

  constructor(private now: () => number) {}

  /** The bot's mood now (neutral once MOOD_MS passed since it was set). */
  mood(id: string): Mood {
    const m = this.moods.get(id);
    if (!m || this.now() - m.at >= MOOD_MS) return 'neutral';
    return m.mood;
  }

  set(id: string, mood: Mood): void {
    if (mood === 'neutral') this.moods.delete(id);
    else this.moods.set(id, { mood, at: this.now() });
  }

  /** The bot started (true) or stopped (false) actively working (coding, reviewing, testing…). */
  working(id: string, on: boolean): void {
    const w = this.work.get(id) ?? { acc: 0, since: null };
    if (on && w.since === null) w.since = this.now();
    if (!on && w.since !== null) { w.acc += this.now() - w.since; w.since = null; }
    this.work.set(id, w);
  }

  /** Work in the current stint so far. */
  worked(id: string): number {
    const w = this.work.get(id);
    if (!w) return 0;
    return w.acc + (w.since === null ? 0 : this.now() - w.since);
  }

  /** The duty stint ended (the bot is back to office life): was it tiring? The work counter starts over. */
  endStint(id: string): boolean {
    const tired = this.worked(id) > TIRED_MS;
    this.work.delete(id);
    return tired;
  }

  forget(id: string): void { this.moods.delete(id); this.work.delete(id); }
}
