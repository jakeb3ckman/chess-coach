// Judging a move on a card (Phase 3). Tactics cards have one right answer, the
// engine's best move. Leak cards (deck 'opening') accept every move within
// right_within Win% of the best, from the stored position pass; the leak card is
// made only when that list is complete (docs/phase-3-plan.md, A.5).
import type { AppCard, OpeningRules } from './types.ts';

export type Verdict =
  | { kind: 'right' }
  | { kind: 'playable'; behind: number } // close, but not close enough: counts as wrong
  | { kind: 'habit' } // a move I played in this position in my games
  | { kind: 'wrong' };

export const DEFAULT_RULES: OpeningRules = { right_within: 2, playable_within: 5, leak_cards_per_day: 3 };

export function rightMoves(card: AppCard): string[] {
  return card.deck === 'opening' && card.right?.length ? card.right : [card.solution];
}

export function judge(card: AppCard, uci: string, rules: OpeningRules = DEFAULT_RULES): Verdict {
  if (rightMoves(card).includes(uci)) return { kind: 'right' };
  if (card.occ.some((o) => o.move === uci)) return { kind: 'habit' };
  const alt = card.alts?.find((a) => a.u === uci);
  if (card.deck === 'opening' && alt && alt.behind <= rules.playable_within) return { kind: 'playable', behind: alt.behind };
  return { kind: 'wrong' };
}
