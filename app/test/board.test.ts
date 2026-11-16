// 2.5.2: the board must take moves after "Finish later" and Resume, including when
// the app was updated (restarted) in between. Bug in 2.5.1: after an update, Resume
// onto a Black card gave a board that ignored every tap (src/board.ts explains why).
//
// Node has no DOM here, so chessground runs as a stand-in that copies the two
// rules of the installed chessground that matter; the last test checks that the
// installed chessground still has them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { idle, show, type BoardApi } from '../src/board.ts';
import { deriveSet } from '../src/session.ts';
import { legalDests } from '../src/chessutil.ts';
import type { Config } from '@lichess-org/chessground/config';
import type { Key } from '@lichess-org/chessground/types';
import type { AppCard, CardsFile, ReviewEventV2 } from '../src/types.ts';

/** Chessground's input handling, reduced to its rules:
 *  - building the board (creation, redrawAll, orientation change) attaches the
 *    touch/mouse handlers only if the board is not viewOnly at that moment;
 *  - set() changes the orientation (rebuilding the board) before applying the rest. */
class StandIn implements BoardApi {
  state = { viewOnly: false, orientation: 'white' as 'white' | 'black', movable: undefined as 'white' | 'black' | undefined };
  handlers = false;
  constructor(config: Config) { this.apply(config); this.redrawAll(); }
  private apply(c: Config) {
    if (c.viewOnly !== undefined) this.state.viewOnly = c.viewOnly;
    if (c.movable && 'color' in c.movable) this.state.movable = c.movable.color as 'white' | 'black' | undefined;
  }
  set(c: Config) {
    if (c.orientation && c.orientation !== this.state.orientation) { this.state.orientation = c.orientation; this.redrawAll(); }
    this.apply(c);
  }
  redrawAll() { this.handlers = !this.state.viewOnly; }
  /** Does a tap on one of the movable side's pieces reach the app? */
  takesMove() { return this.handlers && !this.state.viewOnly && this.state.movable !== undefined; }
}

const trainerBoard = () => new StandIn({ movable: { free: false, showDests: true } }); // as main.ts creates it
const sample = JSON.parse(readFileSync(new URL('./fixtures/cards-sample.json', import.meta.url), 'utf8')) as CardsFile;
const black = sample.cards.find((c) => c.color === 'black')!;
const white = sample.cards.find((c) => c.color === 'white')!;
const showCard = (cg: BoardApi, c: AppCard) => show(cg, {
  fen: c.fen, orientation: c.color, check: false, movable: c.color, dests: legalDests(c.fen) as Map<Key, Key[]>, shapes: [],
});

test('a set saved before an update takes a move after Resume (the app restarts facing White, next card is Black)', () => {
  // The saved set: a set event and one answered card, from before the update.
  const ev = (x: Partial<ReviewEventV2>): ReviewEventV2 => ({
    id: `e${x.ts}`, v: 2, card_id: '', ts: '', day: '2026-11-16', device: 'iphone', kind: 'set', showing: 0, sched: false, ...x,
  });
  const set = deriveSet('2026-11-16', [
    ev({ ts: '2026-11-16T12:00:00Z', round: 1, cards: [white.id, black.id] }),
    ev({ ts: '2026-11-16T12:01:00Z', kind: 'move', card_id: white.id, showing: 1, correct: true }),
  ]);
  assert.equal(set.order[0], black.id);
  const cg = trainerBoard(); // after the update the page starts again: a new board, facing White
  idle(cg); // "Set saved" screen
  showCard(cg, black); // Resume
  assert.ok(cg.takesMove());
});

test('Finish later and Resume within one version, either colour', () => {
  for (const next of [white, black]) {
    const cg = trainerBoard();
    showCard(cg, white);
    assert.ok(cg.takesMove());
    idle(cg); // Finish later
    assert.ok(!cg.takesMove()); // nothing can be moved on the "Set saved" screen
    showCard(cg, next); // Resume
    assert.ok(cg.takesMove(), `resume onto a ${next.color} card`);
  }
});

test('opening the Menu on an idle screen (board rebuilt) still leaves a working board', () => {
  const cg = trainerBoard();
  idle(cg);
  cg.redrawAll(); // Train from the menu redraws the board
  showCard(cg, white);
  assert.ok(cg.takesMove());
});

test('the 2.5.1 sequence reproduces the bug, and show() recovers a viewOnly board', () => {
  const cg = trainerBoard();
  cg.set({ viewOnly: true, movable: { color: undefined } }); // 2.5.1's idle screen
  cg.set({ orientation: 'black', viewOnly: false, movable: { color: 'black' } }); // 2.5.1's next card
  assert.ok(!cg.takesMove()); // the bug: taps ignored
  const cg2 = trainerBoard();
  cg2.set({ viewOnly: true });
  showCard(cg2, black);
  assert.ok(cg2.takesMove());
});

test('the installed chessground still has the two rules the stand-in copies', () => {
  const dist = dirname(createRequire(import.meta.url).resolve('@lichess-org/chessground'));
  const events = readFileSync(join(dist, 'events.js'), 'utf8');
  const bindBoard = events.slice(events.indexOf('export function bindBoard'), events.indexOf('export function bindDocument'));
  assert.match(bindBoard, /if \(s\.viewOnly\)\s*return;/);
  const api = readFileSync(join(dist, 'api.js'), 'utf8');
  const from = api.indexOf('set(config)');
  const set = api.slice(from, api.indexOf('getFen', from));
  assert.ok(set.indexOf('toggleOrientation()') < set.indexOf('configure('), 'orientation is changed before the rest is applied');
  assert.match(api, /function toggleOrientation\(\) \{\s*board\.toggleOrientation\(state\);\s*redrawAll\(\);/);
});
