// Review scheduling. All of the scheduling math is ts-fsrs; this file only fixes
// its configuration and decides WHICH events feed it: per card, only the first
// showing of each study day (spec section 6.1). Later showings that day are drilling.
import { DefaultScheduler, Rating, State, type Grade } from 'ts-fsrs';
import { dayKey } from './day.ts';
import type { ReviewEvent } from './types.ts';

// Fixed settings: every device must compute the same schedule from the same
// events, so no fuzz and an explicit model version.
//  - learning steps 1 day / 2 days: a new card missed returns the next day, a new
//    card answered right returns in 2 days (then FSRS takes over);
//  - relearning step 1 day: a known card missed returns the next day;
//  - allowModelOverride off: without it FSRS-7 may jump a right answer on a new
//    card straight to about 5 days, skipping the 2-day step.
export const FSRS_CONFIG = {
  version: 'FSRS-7',
  desiredRetention: 0.9,
  enableShortTerm: true,
  learningSteps: ['1d', '2d'],
  relearningSteps: ['1d'],
  allowModelOverride: false,
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
  introduced_at: string; // ts of the card's first event
  last_sched_day: string; // study day of the last event that fed the scheduler
  last_ts: string;
  n_events: number; // all events for this card, drilling included
  habit: number; // showings where my wrong move was the move I played in a game
}

export { Rating, State };

let cached: Promise<Scheduler> | null = null;
export function getScheduler(): Promise<Scheduler> {
  cached ??= (DefaultScheduler as unknown as (c: object) => Promise<Scheduler>)({
    ...FSRS_CONFIG,
    learningSteps: [...FSRS_CONFIG.learningSteps],
    relearningSteps: [...FSRS_CONFIG.relearningSteps],
  });
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

export function eventDay(ev: ReviewEvent): string {
  return ev.v === 2 ? ev.day : dayKey(new Date(ev.ts));
}

/** Rating to feed FSRS for this event, or null if it is drilling.
 * firstOfDay: whether this is the card's first format-1 event that study day. */
export function schedRating(ev: ReviewEvent, firstOfDay: boolean): number | null {
  if (ev.v === 2) return ev.sched ? ev.rating ?? null : null;
  return firstOfDay ? ev.rating : null; // format 1: the first answer of the day counts
}

export function isHabit(ev: ReviewEvent, gameMoves?: Set<string>): boolean {
  if (ev.v === 2) return ev.kind === 'move' && !!ev.habit;
  return !ev.correct && !!gameMoves?.has(ev.move_played);
}

/** Apply one event on top of a card's state. Drilling events only update counters. */
export function applyEvent(
  s: Scheduler, prev: CardState | undefined, ev: ReviewEvent, rating: number | null, habit = false,
): CardState {
  const now = new Date(ev.ts);
  let fsrs = prev?.fsrs;
  let schedDay = prev?.last_sched_day ?? '';
  if (rating !== null) {
    fsrs = s.review({ card: fsrs ?? s.newCard({ now, cardId: ev.card_id }), grade: rating as Grade, now }).card;
    schedDay = eventDay(ev);
  }
  return {
    card_id: ev.card_id,
    fsrs: fsrs ?? s.newCard({ now, cardId: ev.card_id }),
    introduced_at: prev ? prev.introduced_at : ev.ts,
    last_sched_day: schedDay,
    last_ts: ev.ts,
    n_events: (prev?.n_events ?? 0) + 1,
    habit: (prev?.habit ?? 0) + (habit ? 1 : 0),
  };
}

/** Rebuild one card's state from all of its events, in time order. Used by the
 * format-1 migration and later by sync. Duplicate event ids count once. */
export function replayCard(s: Scheduler, events: ReviewEvent[], gameMoves?: Set<string>): CardState | undefined {
  const seen = new Set<string>();
  const sorted = events
    .filter((e) => !(e.v === 2 && e.kind === 'set'))
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  let st: CardState | undefined;
  // Only the first answer of each study day moves the schedule, across devices
  // too: if both devices answered the card offline on the same day, the earlier
  // answer counts and the later one is drilling (spec 6.2).
  const schedDays = new Set<string>();
  for (const ev of sorted) {
    const d = eventDay(ev);
    let rating = schedRating(ev, !schedDays.has(d));
    if (rating !== null && schedDays.has(d)) rating = null;
    if (rating !== null) schedDays.add(d);
    st = applyEvent(s, st, ev, rating, isHabit(ev, gameMoves));
  }
  return st;
}

/** When the card would come back if this rating were given now (for button captions). */
export function previewDue(s: Scheduler, prev: CardState | undefined, rating: number, now: Date, cardId: string): Date {
  const base = prev?.fsrs ?? s.newCard({ now, cardId });
  return s.review({ card: base, grade: rating as Grade, now }).card.dueAt;
}

/** Has this card already had its scheduling event this study day? */
export function scheduledToday(st: CardState | undefined, today: string): boolean {
  return !!st && st.last_sched_day === today;
}
