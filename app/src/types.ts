// Shapes shared across the app. AppCard mirrors coach/build.py:app_cards (format 2).

export interface Occurrence {
  link: string; // original game (Lichess links open at the move)
  site: 'chesscom' | 'lichess';
  move: string; // my move in that game, UCI
  drop: number; // Win% lost, from stored Stockfish output
  label: 'mistake' | 'blunder' | 'inaccuracy';
  tc: 'bullet' | 'blitz' | 'rapid';
  at: string; // YYYY-MM-DD
}

export interface GameMove {
  move: string; // what I played in the latest game with this position, UCI
  eval: string; // engine score after it, pawns from my side ("-4.63", "-M2")
  refutation: string | null; // opponent's engine line after it, UCI (null until computed)
  win_before: number;
  win_after: number;
  move_number: number;
}

export interface AppCard {
  id: string;
  deck: 'tactics' | 'opening';
  fen: string; // position before my move; I am to move
  solution: string; // engine best move, UCI
  line: string; // engine line from fen, space-separated UCI, starts with solution
  best_eval: string; // engine score of that line, pawns from my side
  color: 'white' | 'black';
  prev: string | null; // opponent's move that led to fen
  tags: string[];
  game: GameMove;
  occ: Occurrence[]; // newest first
}

export interface CardsFile {
  format: number;
  cards: AppCard[];
}

export type Status = 'remaining' | 'missed' | 'unsure' | 'known';

/** Format 1 (milestone 2.2, before the rework): one event per answered card. */
export interface ReviewEventV1 {
  id: string;
  v: 1;
  card_id: string;
  ts: string;
  device: string;
  move_played: string;
  correct: boolean;
  rating: number; // ts-fsrs Rating: 1 Again, 3 Good, 4 Easy
  ms_to_answer: number;
}

/** Format 2: one event per thing that happened in a showing. Exactly one event per
 * card per study day has sched=true: the outcome of the first showing that day,
 * and only that one moves the long-term schedule. Everything else is drilling. */
export interface ReviewEventV2 {
  id: string; // random; makes re-sent events harmless
  v: 2;
  card_id: string;
  ts: string; // ISO time
  day: string; // study day (starts 4 a.m. local), stored so replay never depends on time zone
  device: string;
  kind: 'move' | 'hint' | 'solution' | 'mymove' | 'grade';
  showing: number; // 1 = first time this card is shown today
  attempt?: number; // move attempts within this showing, 1-based
  move_played?: string; // UCI, for kind 'move'
  correct?: boolean;
  habit?: boolean; // wrong move equals a move I played in a game from this position
  sched: boolean;
  rating?: number; // only when sched: 1 Again, 3 Good, 4 Easy ("Too easy")
  ms?: number; // time since the card appeared
  status_after?: Status;
}

export type ReviewEvent = ReviewEventV1 | ReviewEventV2;
