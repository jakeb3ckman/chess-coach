// Leak cards: judging moves and the daily cap. No positions or evaluations are
// invented here: cards carry placeholder moves and bare numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judge, rightMoves } from '../src/leak.ts';
import { chooseSetCards } from '../src/session.ts';
import type { CardState } from '../src/scheduler.ts';
import type { AppCard, CardsFile } from '../src/types.ts';

const sample = JSON.parse(readFileSync(new URL('./fixtures/cards-sample.json', import.meta.url), 'utf8')) as CardsFile;
const base = sample.cards.find((c) => c.deck === 'tactics')!;

const leak: AppCard = {
  ...base, id: 'leak1', deck: 'opening', fen: '', solution: 'm1', right: ['m1', 'm2'],
  alts: [{ u: 'm1', behind: 0, eval: '' }, { u: 'm2', behind: 1.5, eval: '' }, { u: 'm3', behind: 3.1, eval: '' },
    { u: 'm4', behind: 12, eval: '' }],
  occ: [{ ...base.occ[0], move: 'm4' }],
};

test('leak card: every listed right move is right; close moves are "playable" (still wrong)', () => {
  assert.deepEqual(rightMoves(leak), ['m1', 'm2']);
  assert.deepEqual(judge(leak, 'm1'), { kind: 'right' });
  assert.deepEqual(judge(leak, 'm2'), { kind: 'right' });
  assert.deepEqual(judge(leak, 'm3'), { kind: 'playable', behind: 3.1 });
  assert.deepEqual(judge(leak, 'm4'), { kind: 'habit' }); // my usual move
  assert.deepEqual(judge(leak, 'm9'), { kind: 'wrong' }); // not searched: no better than the 5th line
});

test('tactics card: only the solution is right', () => {
  assert.deepEqual(rightMoves(base), [base.solution]);
  assert.equal(judge(base, base.solution).kind, 'right');
  assert.equal(judge(base, base.occ[0].move).kind, 'habit');
});

test('at most N new leak cards in a pick, inside the overall new-card limit', () => {
  const leaks = Array.from({ length: 6 }, (_, i) => ({ ...leak, id: `L${i}` }));
  const tactics = Array.from({ length: 20 }, (_, i) => ({ ...base, id: `T${i}` }));
  const states = new Map<string, CardState>();
  const pick = chooseSetCards([...leaks, ...tactics], states, new Date(2026, 10, 15, 9), 10, new Set(), 3);
  assert.equal(pick.fresh.length, 10);
  assert.deepEqual(pick.fresh.slice(0, 3), ['L0', 'L1', 'L2']);
  assert.ok(pick.fresh.slice(3).every((id) => id.startsWith('T')));
  const none = chooseSetCards([...leaks, ...tactics], states, new Date(2026, 10, 15, 9), 10, new Set(), 0);
  assert.ok(none.fresh.every((id) => id.startsWith('T')));
});
