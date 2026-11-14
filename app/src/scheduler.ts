// Review scheduling. All of the scheduling math is ts-fsrs; this file only fixes
// its configuration and turns review events into per-card state.
import { DefaultScheduler, Rating, State, type Grade } from 'ts-fsrs';
import type { ReviewEvent } from './types.ts';

// Fixed settings (spec section 3): every device must compute the same schedule
// from the same events, so no fuzz and an explicit model version.
export const FSRS_CONFIG = {
  version: 'FSRS-7',
  desiredRetention: 0.9,
  enableShortTerm: true,
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  enableFuzz: false,
  maximumInterval: 36_500,
} as const;

// The parts of the ts-fsrs scheduler this app uses. (ts-fsrs types the scheduler
// as a union over model versions, which TypeScript cannot call through.)
export interface FsrsCard {
  readonly dueAt: Date;
  readonly lastReviewAt: Date | null;
  readonly state: State;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
}
export interface Scheduler {
  newCard(o: { now: Date; cardId?: string }): FsrsCard;
  review(o: { card: FsrsCard; grade: Grade; now: Date }): { card: FsrsCard };
}

export interface CardState {
  card_id: string;
  fsrs: FsrsCard;
  introduced_at: string; // ts of the card's first review
  last_ts: string; // ts of the latest review applied
  n_events: number;
}

export { Rating, State };

let cached: Promise<Scheduler> | null = null;
export function getScheduler(): Promise<Scheduler> {
  cached ??= (DefaultScheduler as unknown as (c: object) => Promise<Scheduler>)({ ...FSRS_CONFIG, learningSteps: [...FSRS_CONFIG.learningSteps], relearningSteps: [...FSRS_CONFIG.relearningSteps] });
  return cached;
}

/** Card objects read back from JSON need real Date objects again. */
export function reviveFsrs(card: FsrsCard): FsrsCard {
  const c = card as unknown as Record<string, unknown>;
  for (const k of ['dueAt', 'lastReviewAt']) {
    if (typeof c[k] === 'string') c[k] = new Date(c[k] as string);
  }
  return card;
}

/** Apply one review on top of a card's state (or a brand-new card). */
export function applyEvent(s: Scheduler, prev: CardState | undefined, ev: ReviewEvent): CardState {
  const now = new Date(ev.ts);
  const base = prev ? prev.fsrs : s.newCard({ now, cardId: ev.card_id });
  const { card } = s.review({ card: base, grade: ev.rating as Grade, now });
  return {
    card_id: ev.card_id,
    fsrs: card,
    introduced_at: prev ? prev.introduced_at : ev.ts,
    last_ts: ev.ts,
    n_events: (prev?.n_events ?? 0) + 1,
  };
}

/** Rebuild one card's state from all of its events (sync uses this when events
 * from another device arrive out of order). Duplicate event ids count once. */
export function replayCard(s: Scheduler, events: ReviewEvent[]): CardState | undefined {
  const seen = new Set<string>();
  const sorted = events
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  let st: CardState | undefined;
  for (const ev of sorted) st = applyEvent(s, st, ev);
  return st;
}

export function isLearning(st: CardState): boolean {
  return st.fsrs.state === State.Learning || st.fsrs.state === State.Relearning;
}
