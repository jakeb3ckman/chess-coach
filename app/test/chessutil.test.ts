import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { legalDests, lineSteps, sanOf, sideToMove } from '../src/chessutil.ts';
import type { CardsFile } from '../src/types.ts';

const sample = JSON.parse(readFileSync(new URL('./fixtures/cards-sample.json', import.meta.url), 'utf8')) as CardsFile;

function checkCard(c: CardsFile['cards'][number]) {
  assert.equal(sideToMove(c.fen), c.color, `${c.id}: wrong side to move`);
  const steps = lineSteps(c.fen, c.line);
  assert.equal(steps.length, c.line.split(' ').length, `${c.id}: line not fully legal`);
  assert.equal(steps[0].uci, c.solution);
  const [from, to] = [c.solution.slice(0, 2), c.solution.slice(2, 4)];
  assert.ok(legalDests(c.fen).get(from)?.includes(to), `${c.id}: solution not offered on the board`);
  for (const o of c.occ) assert.ok(sanOf(c.fen, o.move), `${c.id}: game move illegal`);
  if (c.prev) {
    // The previous move must be one that can lead to this position: it lands on a square now occupied.
    assert.ok(new Chess(c.fen).get(c.prev.slice(2, 4) as never), `${c.id}: previous move target empty`);
  }
}

test('sample cards: solution, engine line and game moves are legal', () => {
  for (const c of sample.cards) checkCard(c);
});

test('numbered move labels', () => {
  const black = sample.cards.find((c) => c.color === 'black')!;
  const steps = lineSteps(black.fen, black.line);
  assert.match(steps[0].label, /^\d+\.\.\.\S+$/);
  assert.match(steps[1].label, /^\d+\.\S+$/);
  const white = sample.cards.find((c) => c.color === 'white')!;
  const w = lineSteps(white.fen, white.line);
  assert.match(w[0].label, /^\d+\.\S+$/);
  assert.doesNotMatch(w[1].label, /\./);
});

test('castling solution is offered as the king move to the g/c file', () => {
  const c = sample.cards.find((x) => ['e1g1', 'e8g8', 'e1c1', 'e8c8'].includes(x.solution));
  if (!c) return;
  assert.equal(sanOf(c.fen, c.solution).startsWith('O-O'), true);
});

const full = new URL('../../data/derived/app-cards.json', import.meta.url);
test('every card in the current export is playable', { skip: !existsSync(full) && 'no local export' }, () => {
  const all = JSON.parse(readFileSync(full, 'utf8')) as CardsFile;
  for (const c of all.cards) checkCard(c);
});
