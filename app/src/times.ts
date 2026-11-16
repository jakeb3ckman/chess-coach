// Answer times on clean solves (2.5.0), computed from the review log on the device.
// A clean solve: a showing whose first event is a correct move (right on the first
// try, so no hint, no solution and no miss before it in that showing), with no miss,
// hint or solution on that card earlier the same study day on any device (2.5.1: a
// card shown again minutes after its answer was seen would give an easy best).
// Retries and hinted answers have no time and never count toward a best.
import { eventDay } from './scheduler.ts';
import type { ReviewEvent } from './types.ts';

const isMiss = (e: ReviewEvent) =>
  e.v === 1 ? !e.correct : (e.kind === 'move' && e.correct === false) || e.kind === 'hint' || e.kind === 'solution';

const before = (a: ReviewEvent, b: ReviewEvent) => a.ts < b.ts || (a.ts === b.ts && a.id < b.id);

/** Time (ms) of every clean solve in these events (any card, any device). */
export function cleanSolves(events: ReviewEvent[]): { card: string; ms: number; ts: string; id: string }[] {
  // The first miss of each card on each study day, across devices.
  const firstMiss = new Map<string, ReviewEvent>();
  for (const e of events) {
    if (e.v === 2 && e.kind === 'set') continue;
    if (!isMiss(e)) continue;
    const k = `${e.card_id}|${eventDay(e)}`;
    const f = firstMiss.get(k);
    if (!f || before(e, f)) firstMiss.set(k, e);
  }
  const missedBefore = (e: ReviewEvent) => {
    const f = firstMiss.get(`${e.card_id}|${eventDay(e)}`);
    return !!f && before(f, e);
  };
  const out: { card: string; ms: number; ts: string; id: string }[] = [];
  const first = new Map<string, ReviewEvent>();
  for (const e of events) {
    if (e.v === 1) {
      // Format 1 (milestone 2.2): one event per answer, no retries and no hints, so a
      // correct answer was right on the first try.
      if (e.correct && typeof e.ms_to_answer === 'number' && !missedBefore(e)) out.push({ card: e.card_id, ms: e.ms_to_answer, ts: e.ts, id: e.id });
      continue;
    }
    if (e.kind !== 'move' && e.kind !== 'hint' && e.kind !== 'solution') continue;
    const k = `${e.card_id}|${e.device}|${e.day}|${e.showing}`;
    const f = first.get(k);
    if (!f || before(e, f)) first.set(k, e);
  }
  for (const e of first.values()) {
    if (e.v === 2 && e.kind === 'move' && e.correct === true && (e.attempt ?? 1) === 1 && typeof e.ms === 'number'
      && !missedBefore(e)) {
      out.push({ card: e.card_id, ms: e.ms, ts: e.ts, id: e.id });
    }
  }
  return out;
}

/** Best (lowest) clean-solve time per card, ms. */
export function bestTimes(events: ReviewEvent[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const s of cleanSolves(events)) if (!best.has(s.card) || s.ms < best.get(s.card)!) best.set(s.card, s.ms);
  return best;
}

export function secs(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s - 60 * m)).padStart(2, '0')}`;
}
