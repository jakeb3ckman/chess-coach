import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayEnd, dayKey, returnText } from '../src/day.ts';
import {
  applyOutcome, chooseSetCards, counts, deriveSet, extraSetForecast, isComplete, MISSED_GAP, newStartedToday,
  nextStatus, UNSURE_GAP, type DaySet,
} from '../src/session.ts';
import { applyEvent, getScheduler, Rating, type CardState } from '../src/scheduler.ts';
import type { AppCard, CardsFile, ReviewEvent, ReviewEventV2 } from '../src/types.ts';

const sample = JSON.parse(readFileSync(new URL('./fixtures/cards-sample.json', import.meta.url), 'utf8')) as CardsFile;
// Synthetic ids for counting tests: set logic never looks at positions.
const fake = (n: number): AppCard[] => Array.from({ length: n }, (_, i) => ({ ...sample.cards[0], id: `c${String(i).padStart(4, '0')}` }));
const DAY = '2026-11-15';
let clock = Date.parse('2026-11-15T14:00:00Z');
let seq = 0;
const at = () => new Date((clock += 1000)).toISOString();
const setEv = (cards: string[], round = 1, device = 'iphone'): ReviewEventV2 => ({
  id: `s${seq++}`, v: 2, card_id: '', ts: at(), day: DAY, device, kind: 'set', showing: 0, sched: false, round, cards,
});
const mv = (card: string, showing: number, correct: boolean, device = 'iphone'): ReviewEventV2 => ({
  id: `e${seq++}`, v: 2, card_id: card, ts: at(), day: DAY, device, kind: 'move', showing, sched: false, correct, move_played: 'a1a2',
});
const hint = (card: string, showing: number, device = 'iphone'): ReviewEventV2 => ({
  id: `h${seq++}`, v: 2, card_id: card, ts: at(), day: DAY, device, kind: 'hint', showing, sched: false,
});

test('study day starts at 4 a.m. local', () => {
  assert.equal(dayKey(new Date(2026, 10, 14, 3, 59)), '2026-11-13');
  assert.equal(dayKey(new Date(2026, 10, 14, 4, 0)), '2026-11-14');
  assert.equal(dayEnd(new Date(2026, 10, 14, 23, 0)).getTime(), new Date(2026, 10, 15, 4, 0).getTime());
  const now = new Date(2026, 10, 14, 10, 0);
  assert.equal(returnText(new Date(2026, 10, 15, 10, 0), now), 'tomorrow');
  assert.equal(returnText(new Date(2026, 10, 16, 10, 0), now), 'in 2 days');
});

test('statuses: right first time -> Known; wrong -> Missed -> Unsure -> Known', () => {
  assert.equal(nextStatus('remaining', true), 'known');
  assert.equal(nextStatus('remaining', false), 'missed');
  assert.equal(nextStatus('missed', true), 'unsure');
  assert.equal(nextStatus('unsure', true), 'known');
  assert.equal(nextStatus('unsure', false), 'missed');
});

test('the set is rebuilt from events: missed comes back 3 later, unsure 5 later', () => {
  const ids = fake(8).map((c) => c.id);
  const evs: ReviewEvent[] = [setEv(ids)];
  evs.push(mv(ids[0], 1, false), mv(ids[0], 1, true)); // wrong then solved: the showing is a miss
  let set = deriveSet(DAY, evs);
  assert.equal(set.status[ids[0]], 'missed');
  assert.equal(set.order.indexOf(ids[0]), MISSED_GAP);
  evs.push(mv(ids[1], 1, true));
  evs.push(mv(ids[0], 2, true));
  set = deriveSet(DAY, evs);
  assert.equal(set.status[ids[1]], 'known');
  assert.equal(set.status[ids[0]], 'unsure');
  assert.equal(set.order.indexOf(ids[0]), UNSURE_GAP);
  assert.equal(set.showings[ids[0]], 2);
  assert.deepEqual(counts(set), { remaining: 6, missed: 0, unsure: 1, known: 1 });
});

test('a hint makes the showing a miss even if solved afterwards', () => {
  const ids = fake(2).map((c) => c.id);
  const set = deriveSet(DAY, [setEv(ids), hint(ids[0], 1), mv(ids[0], 1, true)]);
  assert.equal(set.status[ids[0]], 'missed');
});

test('a set completes only when every card is Known; then a second set can start', () => {
  const ids = fake(3).map((c) => c.id);
  const evs: ReviewEvent[] = [setEv(ids)];
  for (const id of ids) evs.push(mv(id, 1, true));
  let set = deriveSet(DAY, evs);
  assert.ok(isComplete(set));
  assert.equal(set.round, 1);
  const more = fake(6).slice(3).map((c) => c.id);
  evs.push(setEv(more, 2));
  set = deriveSet(DAY, evs);
  assert.equal(set.round, 2);
  assert.deepEqual(set.cards, more);
  assert.ok(!isComplete(set));
});

test('two devices: set cards merge, outcomes apply in time order', () => {
  const ids = fake(4).map((c) => c.id);
  const evs: ReviewEvent[] = [setEv(ids.slice(0, 3), 1, 'iphone'), setEv(ids.slice(1, 4), 1, 'mac')];
  evs.push(mv(ids[1], 1, false, 'mac')); // missed on the Mac
  evs.push(mv(ids[1], 1, true, 'iphone')); // right later on the phone (its own first showing)
  const set = deriveSet(DAY, evs);
  assert.deepEqual(set.cards, ids);
  assert.equal(set.status[ids[1]], 'unsure');
  // Same events in any order give the same set.
  const shuffled = deriveSet(DAY, [...evs].reverse());
  assert.deepEqual(shuffled, set);
});

test('legacy test: applyOutcome at the end of the queue', () => {
  const set: DaySet = { day: DAY, round: 1, cards: ['a'], order: ['a'], status: { a: 'remaining' }, showings: {} };
  applyOutcome(set, 'a', false);
  assert.deepEqual(set.order, ['a']);
});

test('choosing cards: due before the day ends and not answered today, then new cards', async () => {
  const s = await getScheduler();
  const cards = fake(30);
  const now = new Date(2026, 10, 15, 9, 0);
  const states = new Map<string, CardState>();
  const mk = (id: string, ts: Date, r: number, day: string) => applyEvent(s, states.get(id), {
    id: `x${seq++}`, v: 2, card_id: id, ts: ts.toISOString(), day, device: 'x', kind: 'grade', showing: 1, sched: true, rating: r,
  }, r);
  states.set(cards[0].id, mk(cards[0].id, new Date(2026, 10, 13, 20, 0), Rating.Good, '2026-11-13')); // due today
  states.set(cards[1].id, mk(cards[1].id, new Date(2026, 10, 15, 8, 0), Rating.Again, '2026-11-15')); // answered today
  const pick = chooseSetCards(cards, states, now, 10);
  assert.deepEqual(pick.due, [cards[0].id]);
  assert.equal(pick.fresh.length, 10);
  assert.ok(!pick.fresh.includes(cards[1].id));
  assert.equal(newStartedToday(states, '2026-11-15'), 1);
  const next = chooseSetCards(cards, states, now, 10, new Set([...pick.due, ...pick.fresh]));
  assert.equal(next.fresh.length, 10);
  assert.ok(next.fresh.every((id) => !pick.fresh.includes(id)));
});

test('extra set forecast', () => {
  assert.deepEqual(extraSetForecast(10, 0.6), { tomorrow: 4, dayAfter: 6 });
  assert.deepEqual(extraSetForecast(10, 0.5), { tomorrow: 5, dayAfter: 5 });
});

test('a simulated year of reviews: choosing and rebuilding sets stays fast', async () => {
  const s = await getScheduler();
  const cards = fake(2530);
  const states = new Map<string, CardState>();
  let t = new Date(2026, 0, 1, 9, 0).getTime();
  for (let i = 0; i < 4000; i++) {
    const c = cards[i % 2530];
    const r = i % 5 === 0 ? Rating.Again : Rating.Good;
    states.set(c.id, applyEvent(s, states.get(c.id), { id: `y${i}`, v: 1, card_id: c.id, ts: new Date(t).toISOString(), device: 'x', move_played: '', correct: r !== 1, rating: r, ms_to_answer: 1 }, r));
    t += 2 * 3600_000;
  }
  const ids = cards.slice(0, 60).map((c) => c.id);
  const day: ReviewEvent[] = [setEv(ids)];
  for (let i = 0; i < 200; i++) day.push(mv(ids[i % 60], Math.floor(i / 60) + 1, i % 3 !== 0));
  const start = performance.now();
  for (let i = 0; i < 10; i++) {
    chooseSetCards(cards, states, new Date(t), 10);
    deriveSet(DAY, day);
  }
  const ms = (performance.now() - start) / 10;
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
});
