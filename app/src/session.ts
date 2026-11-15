// The day's sets (spec section 6.1), in the style of Lotus Chess. Pure functions:
// no storage, no DOM, so they are tested directly.
//
//   Remaining --right first time--> Known
//   any       --wrong / hint / solution--> Missed   (comes back MISSED_GAP cards later)
//   Missed    --right--> Unsure                     (comes back UNSURE_GAP cards later)
//   Unsure    --right--> Known
//
// A set is complete when every card in it is Known. Then another set can be started.
//
// Sets are not stored as mutable records: they are DERIVED from the day's events.
// Starting a set logs a 'set' event (round, cards); every showing logs its events.
// Replaying those in time order rebuilds the same set, statuses and queue order on
// any device, which is what lets sync share set progress.
import { dayEnd, dayKey } from './day.ts';
import { eventDay, type CardState } from './scheduler.ts';
import type { AppCard, ReviewEvent, ReviewEventV2, Status } from './types.ts';

export const NEW_PER_DAY = 10;
export const EXTRA_SET_NEW = 10;
export const MISSED_GAP = 3;
export const UNSURE_GAP = 5;

export interface DaySet {
  day: string;
  round: number; // 1 = the day's first set, 2+ = "Start another set"; 0 = none yet
  cards: string[]; // every card in the current set
  order: string[]; // cards not yet Known, in the order they will be shown; order[0] is next
  status: Record<string, Status>;
  showings: Record<string, number>; // how many times each card has been shown today
}

export function nextStatus(s: Status, correct: boolean): Status {
  if (!correct) return 'missed';
  if (s === 'remaining' || s === 'unsure') return 'known';
  if (s === 'missed') return 'unsure';
  return 'known';
}

/** Record the outcome of one showing of `id` and move it in the queue. */
export function applyOutcome(set: DaySet, id: string, correct: boolean): Status {
  const after = nextStatus(set.status[id] ?? 'remaining', correct);
  set.status[id] = after;
  set.order = set.order.filter((x) => x !== id);
  if (after === 'missed') set.order.splice(Math.min(MISSED_GAP, set.order.length), 0, id);
  else if (after === 'unsure') set.order.splice(Math.min(UNSURE_GAP, set.order.length), 0, id);
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

const byTime = (a: ReviewEvent, b: ReviewEvent) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function isSetEvent(e: ReviewEvent): e is ReviewEventV2 & { kind: 'set' } {
  return e.v === 2 && e.kind === 'set';
}

function isFailure(e: ReviewEvent): boolean {
  if (e.v === 1) return !e.correct;
  return (e.kind === 'move' && e.correct === false) || e.kind === 'hint' || e.kind === 'solution';
}

function isCorrectMove(e: ReviewEvent): boolean {
  return e.v === 1 ? e.correct : e.kind === 'move' && e.correct === true;
}

/** The event that decided each showing: its first failure, else its correct move. */
export function showingOutcomes(events: ReviewEvent[]): { card: string; ok: boolean; ts: string; id: string }[] {
  const groups = new Map<string, ReviewEvent[]>();
  for (const e of [...events].sort(byTime)) {
    if (isSetEvent(e)) continue;
    const key = e.v === 1 ? `${e.card_id}|v1|${e.id}` : `${e.card_id}|${e.device}|${e.showing}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const out: { card: string; ok: boolean; ts: string; id: string }[] = [];
  for (const g of groups.values()) {
    const fail = g.find(isFailure);
    const ok = g.find(isCorrectMove);
    const decided = fail ?? ok;
    if (decided) out.push({ card: decided.card_id, ok: !fail, ts: decided.ts, id: decided.id });
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
}

/** Rebuild the current set of `day` from that day's events (any devices). */
export function deriveSet(day: string, events: ReviewEvent[]): DaySet {
  const dayEvents = events.filter((e) => eventDay(e) === day);
  const sets = dayEvents.filter(isSetEvent).sort(byTime);
  const round = sets.reduce((r, e) => Math.max(r, e.round ?? 1), 0);
  const cards: string[] = [];
  for (const e of sets) {
    if ((e.round ?? 1) !== round) continue;
    for (const id of e.cards ?? []) if (!cards.includes(id)) cards.push(id);
  }
  const set: DaySet = { day, round, cards, order: [...cards], status: {}, showings: {} };
  for (const id of cards) set.status[id] = 'remaining';
  const v1Count: Record<string, number> = {};
  for (const e of dayEvents) {
    if (isSetEvent(e)) continue;
    const n = e.v === 2 ? e.showing : (v1Count[e.card_id] = (v1Count[e.card_id] ?? 0) + 1);
    set.showings[e.card_id] = Math.max(set.showings[e.card_id] ?? 0, n);
  }
  const inSet = new Set(cards);
  for (const o of showingOutcomes(dayEvents)) {
    if (inSet.has(o.card) && set.status[o.card] !== 'known') applyOutcome(set, o.card, o.ok);
  }
  return set;
}

/**
 * Cards for a new set: every card due before the study day ends that has not had
 * its scheduling answer today, then up to `newLimit` new cards in deck order.
 * `exclude`: cards already in an earlier set today.
 */
export function chooseSetCards(
  cards: AppCard[], states: Map<string, CardState>, now: Date, newLimit: number, exclude: Set<string> = new Set(),
  openingLimit = Infinity, // new leak cards (deck 'opening') allowed in this pick
): { due: string[]; fresh: string[] } {
  const end = dayEnd(now).getTime();
  const today = dayKey(now);
  const due: { id: string; at: number }[] = [];
  const fresh: string[] = [];
  let opening = 0;
  for (const c of cards) {
    if (exclude.has(c.id)) continue;
    const st = states.get(c.id);
    if (!st) {
      if (fresh.length >= newLimit) continue;
      if (c.deck === 'opening') {
        if (opening >= openingLimit) continue;
        opening++;
      }
      fresh.push(c.id);
    } else if (st.fsrs.dueAt.getTime() < end && st.last_sched_day !== today) {
      due.push({ id: c.id, at: st.fsrs.dueAt.getTime() });
    }
  }
  due.sort((a, b) => a.at - b.at);
  return { due: due.map((d) => d.id), fresh };
}

/** New cards already started today (their first event was today). */
export function newStartedToday(states: Map<string, CardState>, day: string): number {
  let n = 0;
  for (const st of states.values()) if (dayKey(new Date(st.introduced_at)) === day) n++;
  return n;
}

/** New cards of one deck started today. */
export function newStartedTodayIn(states: Map<string, CardState>, day: string, ids: Set<string>): number {
  let n = 0;
  for (const st of states.values()) if (ids.has(st.card_id) && dayKey(new Date(st.introduced_at)) === day) n++;
  return n;
}

/**
 * What an extra set of `n` new cards adds to the coming days. A new card missed on
 * its first try comes back tomorrow; one right first time in 2 days (spec 4).
 * `firstTryRate` is the share of first answers that were right recently.
 */
export function extraSetForecast(n: number, firstTryRate: number): { tomorrow: number; dayAfter: number } {
  return { tomorrow: Math.round(n * (1 - firstTryRate)), dayAfter: Math.round(n * firstTryRate) };
}
