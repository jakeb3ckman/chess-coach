import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildQueue, dayKey, nextCard } from '../src/queue.ts';
import { applyEvent, getScheduler, Rating, type CardState } from '../src/scheduler.ts';
import type { AppCard, CardsFile, ReviewEvent } from '../src/types.ts';

const sample = JSON.parse(readFileSync(new URL('./fixtures/cards-sample.json', import.meta.url), 'utf8')) as CardsFile;

// Synthetic cards for counting tests: queue logic never looks at positions.
const fake = (n: number): AppCard[] =>
  Array.from({ length: n }, (_, i) => ({ ...sample.cards[0], id: `c${String(i).padStart(4, '0')}` }));

let seq = 0;
const ev = (card_id: string, ts: Date, rating: number): ReviewEvent => ({
  id: `e${seq++}`, v: 1, card_id, ts: ts.toISOString(), device: 'test',
  move_played: 'a1a1', correct: rating !== Rating.Again, rating, ms_to_answer: 1000,
});

test('day rolls over at 4 a.m. local time', () => {
  assert.equal(dayKey(new Date(2026, 10, 14, 3, 59)), '2026-11-13');
  assert.equal(dayKey(new Date(2026, 10, 14, 4, 0)), '2026-11-14');
  assert.equal(dayKey(new Date(2026, 10, 14, 23, 30)), '2026-11-14');
});

test('at most 10 new cards a day, in deck order', async () => {
  const s = await getScheduler();
  const cards = fake(30);
  const now = new Date(2026, 10, 14, 9, 0);
  const states = new Map<string, CardState>();
  let q = buildQueue(cards, states, now);
  assert.deepEqual(q.fresh.map((c) => c.id), cards.slice(0, 10).map((c) => c.id));
  // Introduce 4 cards today (answered right, Easy, so they leave the learning steps).
  for (const c of cards.slice(0, 4)) states.set(c.id, applyEvent(s, undefined, ev(c.id, now, Rating.Easy)));
  q = buildQueue(cards, states, new Date(now.getTime() + 60_000));
  assert.equal(q.newToday, 4);
  assert.deepEqual(q.fresh.map((c) => c.id), cards.slice(4, 10).map((c) => c.id));
  // Next day (after 4 a.m.) the allowance is back to 10.
  q = buildQueue(cards, states, new Date(2026, 10, 15, 4, 1));
  assert.equal(q.newToday, 0);
  assert.equal(q.fresh.length, 10);
});

test('a missed card comes back after 1 minute, before new cards', async () => {
  const s = await getScheduler();
  const cards = fake(5);
  const now = new Date(2026, 10, 14, 9, 0);
  const states = new Map([[cards[0].id, applyEvent(s, undefined, ev(cards[0].id, now, Rating.Again))]]);
  let q = buildQueue(cards, states, new Date(now.getTime() + 30_000));
  assert.equal(q.due.length, 0);
  assert.equal(q.later[0].card.id, cards[0].id);
  assert.equal(nextCard(q)?.id, cards[1].id);
  q = buildQueue(cards, states, new Date(now.getTime() + 61_000));
  assert.equal(nextCard(q)?.id, cards[0].id);
});

test('due cards come earliest-due first', async () => {
  const s = await getScheduler();
  const cards = fake(3);
  const t0 = new Date(2026, 10, 1, 9, 0);
  const states = new Map<string, CardState>();
  states.set(cards[2].id, applyEvent(s, undefined, ev(cards[2].id, t0, Rating.Easy)));
  states.set(cards[1].id, applyEvent(s, undefined, ev(cards[1].id, new Date(t0.getTime() + 3600_000), Rating.Easy)));
  const q = buildQueue(cards, states, new Date(2027, 0, 1, 9, 0), 0);
  assert.deepEqual(q.due.map((c) => c.id), [cards[2].id, cards[1].id]);
});

test('a simulated year of reviews: building the queue stays fast', async () => {
  // About 4,000 reviews over 2,530 cards, the size of a year of daily use.
  const s = await getScheduler();
  const cards = fake(2530);
  const states = new Map<string, CardState>();
  let t = new Date(2026, 0, 1, 9, 0).getTime();
  for (let i = 0; i < 4000; i++) {
    const c = cards[i % 2530];
    states.set(c.id, applyEvent(s, states.get(c.id), ev(c.id, new Date(t), i % 5 === 0 ? Rating.Again : Rating.Good)));
    t += 2 * 3600_000;
  }
  const start = performance.now();
  for (let i = 0; i < 10; i++) buildQueue(cards, states, new Date(t));
  const ms = (performance.now() - start) / 10;
  assert.ok(ms < 50, `buildQueue took ${ms.toFixed(1)} ms`);
});
