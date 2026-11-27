import { CHARACTERS } from '@office/shared';
import type { ActivityId } from './officeLife';

/**
 * Personalities (M3 §4): one fixed personality per character name. A personality multiplies the office-life activity
 * weights (day and night separately) and may prefer spots with some tags (the arcade, the reading nook, the sofas).
 * OfficeLife still applies the cooldown, the out-of-room cap and feasibility on top.
 */
export interface Personality {
  id: string;
  /** Hover label text, e.g. "coffee lover". */
  label: string;
  day?: Partial<Record<ActivityId, number>>;
  night?: Partial<Record<ActivityId, number>>;
  /** Spot tags this bot picks first when its activity offers a free one of them. */
  prefer?: string[];
}

export const PERSONALITIES: Record<(typeof CHARACTERS)[number], Personality> = {
  Clara: { id: 'coffee', label: 'coffee lover', day: { coffee: 2.5 }, night: { coffee: 2 } },
  Hugo: { id: 'gamer', label: 'gamer', day: { lounge: 1.6, wander: 1.3 }, night: { lounge: 1.8 }, prefer: ['arcade'] },
  Jade: { id: 'bookworm', label: 'bookworm', day: { lounge: 1.5, chat: 0.7 }, night: { lounge: 1.6, chat: 0.7 }, prefer: ['reading'] },
  Leo: { id: 'social', label: 'social', day: { chat: 2.2 }, night: { chat: 2.2 } },
  Lia: { id: 'foodie', label: 'foodie', day: { table: 2, bar: 1.6 }, night: { table: 1.8, bar: 1.6 } },
  Maya: { id: 'chill', label: 'chill', day: { lounge: 2, desk: 0.8 }, night: { lounge: 2 }, prefer: ['sofa'] },
  Nina: { id: 'early-bird', label: 'early bird', day: { desk: 1.5, coffee: 1.4 }, night: { desk: 0.5, lounge: 1.6, bar: 0.6 } },
  Otto: { id: 'night-owl', label: 'night owl', day: { desk: 0.8, lounge: 1.4 }, night: { desk: 1.8, bar: 1.5, lounge: 0.7 } },
  Rosa: { id: 'workaholic', label: 'workaholic', day: { desk: 2 }, night: { desk: 1.6 } },
  Sam: { id: 'explorer', label: 'explorer', day: { wander: 2.2 }, night: { wander: 2 } },
  Theo: { id: 'snacker', label: 'snacker', day: { bar: 2, coffee: 1.3 }, night: { bar: 1.8 } },
  Victor: { id: 'homebody', label: 'homebody', day: { desk: 1.4, wander: 1.2, lounge: 0.7, bar: 0.7 }, night: { desk: 1.4, lounge: 0.8 } },
};

/** The personality of a character name (none for an unknown name). */
export const personalityOf = (character: string | undefined): Personality | undefined =>
  character ? (PERSONALITIES as Record<string, Personality>)[character] : undefined;

/** Base weights × the personality's multipliers for that time of day (missing multipliers are 1). */
export function personalWeights(base: Record<ActivityId, number>, p: Personality | undefined, night: boolean): Record<ActivityId, number> {
  const m = (night ? p?.night : p?.day) ?? {};
  return Object.fromEntries(Object.entries(base).map(([a, w]) => [a, w * (m[a as ActivityId] ?? 1)])) as Record<ActivityId, number>;
}
