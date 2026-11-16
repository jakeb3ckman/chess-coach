// Setting up the trainer board between cards (2.5.2).
//
// Chessground attaches the board's touch and mouse handlers only when it builds
// the board (at creation, on redrawAll, and on an orientation change, which calls
// redrawAll), and only if the board is not viewOnly at that moment
// (chessground dist/events.js, bindBoard: `if (s.viewOnly) return;`). Turning
// viewOnly off later does not attach them.
//
// Up to 2.5.1 the idle screens ("Set saved", "Set complete") set viewOnly, and the
// next card's set() changed the orientation first, so the board was rebuilt while
// still viewOnly and ignored every tap. It showed after an update: the app restarts
// with the board facing White, and Resume then showed a Black card. Opening the
// Menu on an idle screen (redrawAll) had the same effect for any card.
//
// So the trainer board is never viewOnly: when idle it just has no movable side,
// like the answer screen. And if it ever is viewOnly, show() rebuilds it after
// turning that off, so the handlers are attached.
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import type { Config } from '@lichess-org/chessground/config';

/** The part of chessground's Api used here (lets tests use a stand-in). */
export interface BoardApi {
  set(config: Config): void;
  redrawAll(): void;
  state: { viewOnly: boolean };
}

/** Between cards: nothing can be moved, but the board stays able to take input later. */
export function idle(cg: BoardApi) {
  cg.set({ movable: { color: undefined, dests: new Map() }, drawable: { autoShapes: [] } });
}

export interface Position {
  fen: string;
  orientation: 'white' | 'black';
  lastMove?: Key[];
  check: boolean;
  movable: 'white' | 'black' | undefined; // the side that may move, or none
  dests: Map<Key, Key[]>;
  shapes: DrawShape[];
}

export function show(cg: BoardApi, p: Position) {
  const rebuild = cg.state.viewOnly;
  if (rebuild) cg.set({ viewOnly: false });
  cg.set({
    fen: p.fen,
    orientation: p.orientation,
    turnColor: p.fen.split(' ')[1] === 'w' ? 'white' : 'black',
    lastMove: p.lastMove,
    check: p.check,
    movable: { color: p.movable, dests: p.movable ? p.dests : new Map() },
    drawable: { autoShapes: p.shapes },
  });
  if (rebuild) cg.redrawAll(); // attaches the touch and mouse handlers
}
