// 2.5.0: training by colour or opening (new cards only) and clean-solve times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterOk, filterOptions } from '../src/filter.ts';
import { chooseSetCards } from '../src/session.ts';
import { applyEvent, getScheduler, Rating, type CardState } from '../src/scheduler.ts';
import { bestTimes, cleanSolves, secs } from '../src/times.ts';
import type { AppCard, CardsFile, ReviewEventV1, ReviewEventV2 } from '../src/types.ts';

const sample = JSON.parse(readFileSync(new URL('./fixtures/cards-sample.json', import.meta.url), 'utf8')) as CardsFile;
// Synthetic cards: the filter only looks at colour, opening and deck, never at positions.
const mk = (i: number, color: 'white' | 'black', opening: string | null, deck: 'tactics' | 'opening' = 'tactics'): AppCard =>
  ({ ...sample.cards[0], id: `c${i}`, color, opening, deck });
const cards = [
  mk(0, 'white', 'Italian Game'), mk(1, 'black', 'Caro-Kann Defense'), mk(2, 'white', 'Italian Game', 'opening'),
  mk(3, 'white', 'Italian Game', 'opening'), mk(4, 'black', 'Caro-Kann Defense', 'opening'), mk(5, 'black', null),
  mk(6, 'white', 'Italian Game', 'opening'), mk(7, 'white', 'Italian Game', 'opening'), mk(8, 'black', 'Italian Game'),
];

test('filter: colour and opening group (colour and name together)', () => {
  assert.deepEqual(cards.filter(filterOk('white')).map((c) => c.id), ['c0', 'c2', 'c3', 'c6', 'c7']);
  assert.deepEqual(cards.filter(filterOk('black')).map((c) => c.id), ['c1', 'c4', 'c5', 'c8']);
  // 'Italian Game' as White is a different group from 'Italian Game' as Black.
  assert.deepEqual(cards.filter(filterOk('o:black:Italian Game')).map((c) => c.id), ['c8']);
  assert.equal(cards.filter(filterOk('all')).length, cards.length);
  const opts = filterOptions(cards, (id) => id === 'c0');
  assert.deepEqual(opts.slice(0, 3).map((o) => [o.value, o.fresh]), [['all', 8], ['white', 4], ['black', 4]]);
  assert.deepEqual(opts.slice(3).map((o) => [o.group, o.label, o.fresh]),
    [['white', 'Italian Game', 4], ['black', 'Caro-Kann Defense', 2], ['black', 'Italian Game', 1]]);
});

test('filter applies to new cards only; due reviews always come; leak cap still applies', async () => {
  const s = await getScheduler();
  const states = new Map<string, CardState>();
  // c1 (Black, Caro-Kann) was answered two days ago and is due today.
  states.set('c1', applyEvent(s, undefined, {
    id: 'x1', v: 2, card_id: 'c1', ts: new Date(2026, 10, 13, 20, 0).toISOString(), day: '2026-11-13', device: 'x',
    kind: 'grade', showing: 1, sched: true, rating: Rating.Good,
  }, Rating.Good));
  const now = new Date(2026, 10, 15, 9, 0);
  const pick = chooseSetCards(cards, states, now, 10, new Set(), 3, filterOk('o:white:Italian Game'));
  assert.deepEqual(pick.due, ['c1']); // not White, not Italian, but due: it comes anyway
  assert.deepEqual(pick.fresh, ['c0', 'c2', 'c3', 'c6']); // only 3 of the 4 leak cards (c2, c3, c6; c7 waits)
  const all = chooseSetCards(cards, states, now, 10, new Set(), 3);
  assert.deepEqual(all.fresh, ['c0', 'c2', 'c3', 'c4', 'c5', 'c8']);
});

let n = 0;
const ev = (card: string, kind: ReviewEventV2['kind'], extra: Partial<ReviewEventV2> = {}): ReviewEventV2 => ({
  id: `e${n++}`, v: 2, card_id: card, ts: new Date(Date.UTC(2026, 10, 15, 12, 0, n)).toISOString(), day: '2026-11-15',
  device: 'iphone', kind, showing: 1, sched: false, ...extra,
});

test('clean solves: right on the first try only; retries, hints and solutions never count', () => {
  const evs = [
    ev('a', 'move', { correct: true, attempt: 1, ms: 5200 }), // clean
    ev('a', 'grade', { sched: true, rating: 3 }),
    ev('b', 'move', { correct: false, attempt: 1, ms: 3000 }), // miss, then right: no time
    ev('b', 'move', { correct: true, attempt: 2, ms: 9000 }),
    ev('c', 'hint', { ms: 2000 }), // hint, then right: no time
    ev('c', 'move', { correct: true, attempt: 1, ms: 4000 }),
    ev('d', 'solution', { ms: 1000 }),
    ev('b', 'move', { correct: true, attempt: 1, ms: 2500, showing: 2 }), // a later showing, clean within it
    ev('a', 'move', { correct: true, attempt: 1, ms: 3100, day: '2026-11-17' }), // another day, same showing number
  ];
  assert.deepEqual(cleanSolves(evs).map((x) => [x.card, x.ms]).sort(), [['a', 3100], ['a', 5200], ['b', 2500]]);
  assert.deepEqual([...bestTimes(evs)].sort(), [['a', 3100], ['b', 2500]]);
  const v1: ReviewEventV1 = { id: 'v1', v: 1, card_id: 'z', ts: '2026-11-13T10:00:00Z', device: 'mac', move_played: 'a1a2', correct: true, rating: 3, ms_to_answer: 7000 };
  assert.deepEqual(cleanSolves([v1, { ...v1, id: 'v2', correct: false }]).map((x) => x.ms), [7000]);
  assert.equal(secs(4230), '4.2 s');
  assert.equal(secs(65000), '1:05');
});
