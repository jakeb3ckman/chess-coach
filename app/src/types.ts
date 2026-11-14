// Shapes shared across the app. AppCard mirrors coach/build.py:app_cards.

export interface Occurrence {
  link: string; // original game (Lichess links open at the move)
  site: 'chesscom' | 'lichess';
  move: string; // my move in that game, UCI
  drop: number; // Win% lost, from stored Stockfish output
  label: 'mistake' | 'blunder' | 'inaccuracy';
  tc: 'bullet' | 'blitz' | 'rapid';
  at: string; // YYYY-MM-DD
}

export interface AppCard {
  id: string;
  deck: 'tactics' | 'opening';
  fen: string; // position before my move; I am to move
  solution: string; // engine best move, UCI
  line: string; // engine line from fen, space-separated UCI, starts with solution
  color: 'white' | 'black';
  prev: string | null; // opponent's move that led to fen
  occ: Occurrence[]; // newest first
}

export interface CardsFile {
  format: number;
  cards: AppCard[];
}

/** One answered card. Append-only; the same shape is uploaded by sync (2.3). */
export interface ReviewEvent {
  id: string; // random; makes re-sent events harmless
  v: 1;
  card_id: string;
  ts: string; // ISO time of the answer
  device: string;
  move_played: string; // UCI
  correct: boolean;
  rating: number; // ts-fsrs Rating: 1 Again, 3 Good, 4 Easy
  ms_to_answer: number;
}
