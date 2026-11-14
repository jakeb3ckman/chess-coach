// Chess rules come from chess.js; this only adapts them for the board and for display.
import { Chess, SQUARES, type Square } from 'chess.js';

export type Dests = Map<string, string[]>;

export function legalDests(fen: string): Dests {
  const chess = new Chess(fen);
  const dests: Dests = new Map();
  for (const sq of SQUARES) {
    const ms = chess.moves({ square: sq as Square, verbose: true });
    if (ms.length) dests.set(sq, [...new Set(ms.map((m) => m.to))]);
  }
  return dests;
}

export function isPromotion(fen: string, from: string, to: string): boolean {
  const chess = new Chess(fen);
  return chess.moves({ square: from as Square, verbose: true }).some((m) => m.to === to && !!m.promotion);
}

export function sideToMove(fen: string): 'white' | 'black' {
  return new Chess(fen).turn() === 'w' ? 'white' : 'black';
}

export function inCheck(fen: string): boolean {
  return new Chess(fen).inCheck();
}

export function sanOf(fen: string, uci: string): string {
  const chess = new Chess(fen);
  return chess.move(parseUci(uci)).san;
}

export interface LineStep {
  san: string; // e.g. "Nxd4"
  label: string; // e.g. "12...Nxd4" or "13.Qxd4"
  uci: string;
  fenAfter: string;
}

/** Engine line (UCI) as numbered SAN steps, each with the position after it. */
export function lineSteps(fen: string, uciLine: string): LineStep[] {
  const chess = new Chess(fen);
  const steps: LineStep[] = [];
  for (const uci of uciLine.split(' ').filter(Boolean)) {
    const white = chess.turn() === 'w';
    const n = chess.moveNumber();
    let san: string;
    try {
      san = chess.move(parseUci(uci)).san;
    } catch {
      break; // never expected: lines come from Stockfish on this exact position
    }
    const label = white ? `${n}.${san}` : steps.length === 0 ? `${n}...${san}` : san;
    steps.push({ san, label, uci, fenAfter: chess.fen() });
  }
  return steps;
}

export function parseUci(uci: string): { from: string; to: string; promotion?: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
}

export function uciSquares(uci: string): [string, string] {
  return [uci.slice(0, 2), uci.slice(2, 4)];
}
