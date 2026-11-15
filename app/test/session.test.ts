import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayEnd, dayKey, returnText } from '../src/day.ts';
import { applyOutcome, counts, createSet, isComplete, MISSED_GAP, nextStatus, UNSURE_GAP } from '../src/session.ts';
import { applyEvent, getScheduler, Rating, type CardState } from '../src/scheduler.ts';
import type { AppCard, CardsFile, ReviewEventV1 } from '../src/types.ts';

const sample = JSON.parse(readFileSync(new URL('./fixtures/cards-sample.json', import.meta.url), 'utf8')) as CardsFile;
// Synthetic ids for counting tests: set logic never looks at positions.
const fake = (n: number): AppCard[] => Array.from({ length: n }, (_, i) => ({ ...sample.cards[0], id: `c${String(i).padStart(4, '0')}` }));

test('study day starts at 4 a.m. local', () => {
  assert.equal(dayKey(new Date(2026, 10, 14, 3, 59)), '2026-11-13');
  assert.equal(dayKey(new Date(2026, 10, 14, 4, 0)), '2026-11-14');
  assert.equal(dayEnd(new Date(2026, 10, 14, 23, 0)).getTime(), new Date(2026, 10, 15, 4, 0).getTime());
  assert.equal(dayEnd(new Date(2026, 10, 14, 2, 0)).getTime(), new Date(2026, 10, 14, 4, 0).getTime());
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

test('a missed card comes back a few cards later; the set ends when all are Known', () => {
  const set = createSet('2026-11-14', fake(8), new Map(), [], new Date(2026, 10, 14, 9));
  const [a, b] = set.order;
  assert.equal(applyOutcome(set, a, false), 'missed');
  assert.equal(set.order.indexOf(a), MISSED_GAP);
  assert.equal(applyOutcome(set, b, true), 'known');
  assert.ok(!set.order.includes(b));
  assert.equal(applyOutcome(set, a, true), 'unsure');
  assert.equal(set.order.indexOf(a), UNSURE_GAP);
  assert.deepEqual(counts(set), { remaining: 6, missed: 0, unsure: 1, known: 1 });
  while (set.order.length) applyOutcome(set, set.order[0], true);
  assert.ok(isComplete(set));
  assert.deepEqual(counts(set), { remaining: 0, missed: 0, unsure: 0, known: 8 });
});

test('the last card missed comes straight back', () => {
  const set = createSet('2026-11-14', fake(1), new Map(), [], new Date(2026, 10, 14, 9));
  applyOutcome(set, set.order[0], false);
  assert.equal(set.order.length, 1);
  assert.ok(!isComplete(set));
});

test('the set: due today + up to 10 new, minus new already started today', async () => {
  const s = await getScheduler();
  const cards = fake(40);
  const now = new Date(2026, 10, 14, 9, 0);
  const states = new Map<string, CardState>();
  // Two cards reviewed 2 days ago (right, 2-day step): due today.
  const twoDaysAgo = new Date(2026, 10, 12, 20, 0).toISOString();
  for (const c of cards.slice(0, 2)) {
    states.set(c.id, applyEvent(s, undefined, { id: c.id, v: 1, card_id: c.id, ts: twoDaysAgo, device: 'x', move_played: '', correct: true, rating: Rating.Good, ms_to_answer: 1 }, Rating.Good));
  }
  // One card due in 10 days: not in the set.
  const st = applyEvent(s, undefined, { id: 'z', v: 1, card_id: cards[2].id, ts: now.toISOString(), device: 'x', move_played: '', correct: true, rating: Rating.Easy, ms_to_answer: 1 }, Rating.Easy);
  states.set(cards[2].id, st);
  const set = createSet('2026-11-14', cards, states, [], now);
  assert.deepEqual(set.cards.slice(0, 2), [cards[0].id, cards[1].id]);
  assert.ok(!set.cards.includes(cards[2].id));
  // cards[2] was introduced today, so 9 new cards remain.
  assert.equal(set.cards.length, 2 + 9);
});

test('update day: reviews already done today keep their status in the set', async () => {
  const s = await getScheduler();
  const cards = fake(20);
  const now = new Date(2026, 10, 14, 12, 0);
  const t = (h: number, m: number) => new Date(2026, 10, 14, h, m).toISOString();
  const evs: ReviewEventV1[] = [
    { id: '1', v: 1, card_id: cards[0].id, ts: t(9, 0), device: 'x', move_played: 'a', correct: true, rating: 3, ms_to_answer: 1 },
    { id: '2', v: 1, card_id: cards[1].id, ts: t(9, 1), device: 'x', move_played: 'a', correct: false, rating: 1, ms_to_answer: 1 },
    { id: '3', v: 1, card_id: cards[2].id, ts: t(9, 2), device: 'x', move_played: 'a', correct: false, rating: 1, ms_to_answer: 1 },
    { id: '4', v: 1, card_id: cards[2].id, ts: t(9, 5), device: 'x', move_played: 'a', correct: true, rating: 3, ms_to_answer: 1 },
  ];
  const states = new Map<string, CardState>();
  for (const e of evs) states.set(e.card_id, applyEvent(s, states.get(e.card_id), e, e.rating));
  const set = createSet('2026-11-14', cards, states, evs, now);
  assert.equal(set.status[cards[0].id], 'known');
  assert.equal(set.status[cards[1].id], 'missed');
  assert.equal(set.status[cards[2].id], 'unsure');
  assert.deepEqual(set.order.slice(0, 2), [cards[1].id, cards[2].id]);
  assert.equal(set.cards.length, 3 + 7); // 3 started today, so 7 more new
});

test('a simulated year of reviews: making the set stays fast', async () => {
  const s = await getScheduler();
  const cards = fake(2530);
  const states = new Map<string, CardState>();
  let t = new Date(2026, 0, 1, 9, 0).getTime();
  for (let i = 0; i < 4000; i++) {
    const c = cards[i % 2530];
    const r = i % 5 === 0 ? Rating.Again : Rating.Good;
    states.set(c.id, applyEvent(s, states.get(c.id), { id: `e${i}`, v: 1, card_id: c.id, ts: new Date(t).toISOString(), device: 'x', move_played: '', correct: r !== 1, rating: r, ms_to_answer: 1 }, r));
    t += 2 * 3600_000;
  }
  const start = performance.now();
  for (let i = 0; i < 10; i++) createSet('2026-12-31', cards, states, [], new Date(t));
  const ms = (performance.now() - start) / 10;
  assert.ok(ms < 50, `createSet took ${ms.toFixed(1)} ms`);
});
