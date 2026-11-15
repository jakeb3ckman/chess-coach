// The day's set (spec section 6.1), in the style of Lotus Chess. Pure functions:
// no storage, no DOM, so they are tested directly.
//
//   Remaining --right first time--> Known
//   any       --wrong / hint / solution--> Missed   (comes back MISSED_GAP cards later)
//   Missed    --right--> Unsure                     (comes back UNSURE_GAP cards later)
//   Unsure    --right--> Known
//
// The set is complete when every card in it is Known.
import { dayEnd } from './day.ts';
import { eventDay, type CardState } from './scheduler.ts';
import type { AppCard, ReviewEvent, Status } from './types.ts';

export const NEW_PER_DAY = 10;
export const MISSED_GAP = 3;
export const UNSURE_GAP = 5;

export interface DaySet {
  day: string;
  created_at: string;
  cards: string[]; // every card in the set, fixed when the set is made
  order: string[]; // cards not yet Known, in the order they will be shown; order[0] is next
  status: Record<string, Status>;
  showings: Record<string, number>; // how many times each card has been shown today
  pending_grade?: string; // card answered right first time, waiting for Next / Too easy
  paused?: boolean; // "Finish later"
  completed_at?: string;
}

export function nextStatus(s: Status, correct: boolean): Status {
  if (!correct) return 'missed';
  if (s === 'remaining' || s === 'unsure') return 'known';
  if (s === 'missed') return 'unsure';
  return 'known';
}

/** Record the outcome of the current showing of `id` and move it in the queue. */
export function applyOutcome(set: DaySet, id: string, correct: boolean): Status {
  const after = nextStatus(set.status[id] ?? 'remaining', correct);
  set.status[id] = after;
  set.order = set.order.filter((x) => x !== id);
  if (after === 'missed') set.order.splice(Math.min(MISSED_GAP, set.order.length), 0, id);
  else if (after === 'unsure') set.order.splice(Math.min(UNSURE_GAP, set.order.length), 0, id);
  if (set.order.length === 0 && !set.completed_at) set.completed_at = new Date().toISOString();
  return after;
}

export function counts(set: DaySet): Record<Status, number> {
  const c: Record<Status, number> = { remaining: 0, missed: 0, unsure: 0, known: 0 };
  for (const id of set.cards) c[set.status[id] ?? 'remaining']++;
  return c;
}

export function isComplete(set: DaySet): boolean {
  return set.cards.length > 0 && set.order.length === 0;
}

/** Status of each card from today's events (used when a set has to be rebuilt,
 * e.g. right after the update from format 1 on a day that already had reviews). */
export function statusFromEvents(events: ReviewEvent[]): Map<string, Status> {
  const out = new Map<string, Status>();
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  for (const ev of sorted) {
    const cur = out.get(ev.card_id) ?? 'remaining';
    if (ev.v === 1) out.set(ev.card_id, nextStatus(cur, ev.correct));
    else if (ev.kind === 'hint' || ev.kind === 'solution') out.set(ev.card_id, 'missed');
    else if (ev.kind === 'move' && ev.status_after) out.set(ev.card_id, ev.status_after);
  }
  return out;
}

/**
 * Make today's set: every card due before the study day ends, plus new cards up
 * to the daily limit, plus any card already reviewed today (with its status).
 */
export function createSet(
  day: string, cards: AppCard[], states: Map<string, CardState>, todayEvents: ReviewEvent[], now: Date,
  newPerDay = NEW_PER_DAY,
): DaySet {
  const end = dayEnd(now).getTime();
  const fromEvents = statusFromEvents(todayEvents.filter((e) => eventDay(e) === day));
  const inDeck = new Set(cards.map((c) => c.id));
  let newToday = 0;
  for (const st of states.values()) if (eventDayOf(st.introduced_at) === day) newToday++;
  const due: { id: string; at: number }[] = [];
  const fresh: string[] = [];
  let allowed = Math.max(0, newPerDay - newToday);
  for (const c of cards) {
    if (fromEvents.has(c.id)) continue;
    const st = states.get(c.id);
    if (!st) {
      if (allowed > 0) { fresh.push(c.id); allowed--; }
    } else if (st.fsrs.dueAt.getTime() < end) {
      due.push({ id: c.id, at: st.fsrs.dueAt.getTime() });
    }
  }
  due.sort((a, b) => a.at - b.at);
  const earlier = [...fromEvents.keys()].filter((id) => inDeck.has(id));
  const status: Record<string, Status> = {};
  const showings: Record<string, number> = {};
  for (const id of earlier) { status[id] = fromEvents.get(id)!; showings[id] = 1; }
  const rest = [...due.map((d) => d.id), ...fresh];
  for (const id of rest) status[id] = 'remaining';
  const all = [...earlier, ...rest];
  const order = [...earlier.filter((id) => status[id] !== 'known'), ...rest];
  return {
    day, created_at: now.toISOString(), cards: all, order, status, showings,
    completed_at: all.length && !order.length ? now.toISOString() : undefined,
  };
}

function eventDayOf(ts: string): string {
  return eventDay({ v: 1, ts } as ReviewEvent);
}
