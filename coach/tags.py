"""Card tags. Every rule uses only stored Stockfish output (scores and lines) and
legal-move facts from python-chess. The exact wording of each rule is in
docs/spec.md section 4.1; keep the two in step.

All functions take one mistake (see build.derive_mistakes) and return bool.
"""
from __future__ import annotations

import chess

from .classify import win_pct

VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
OPENING_MAX_MOVE = 10
HUNG_MIN_LOSS = 3          # points of material, standard values P1 N3 B3 R5 Q9
HUNG_MAX_PLIES = 8          # longest capture sequence followed along the refutation line


def mate_for(score, color: str) -> int | None:
    """Mate distance for `color` if the White-view score is a forced mate for them."""
    if isinstance(score, str) and score.startswith("M"):
        n = int(score[2:])
        white_mates = score[1] == "+"
        if white_mates == (color == "white") and n >= 1:
            return n
    return None


def material(board: chess.Board, color: bool) -> int:
    """My material minus the opponent's (color = my side)."""
    total = 0
    for piece in board.piece_map().values():
        v = VALUES[piece.piece_type]
        total += v if piece.color == color else -v
    return total


def is_opening(m: dict) -> bool:
    return m["move_number"] <= OPENING_MAX_MOVE


def is_mate(m: dict) -> bool:
    return mate_for(m["score_before"], m["my_color"]) is not None


def is_allowed_mate(m: dict) -> bool:
    other = "black" if m["my_color"] == "white" else "white"
    return mate_for(m["score_after"], other) is not None


def is_thrown_win(m: dict, cards: dict) -> bool:
    return m["win_before"] > cards["decided_high"] and m["win_after"] < cards["thrown_win_below"]


def _after_captures(board: chess.Board, line: list[str], me: bool, start_index: int = 0) -> int:
    """Play `line` from start_index while every move is a capture (at most
    HUNG_MAX_PLIES plies) and return my material balance at the end."""
    for u in line[start_index:start_index + HUNG_MAX_PLIES]:
        mv = chess.Move.from_uci(u)
        if not board.is_capture(mv):
            break
        board.push(mv)
    return material(board, me)


def winning_capture_gain(m: dict) -> int | None:
    """How much better the engine's capture sequence leaves me than my game move's.

    Best side: from the card position, play the engine's best line for as long as
    every move is a capture (the best move itself must be a capture).
    Game side: from the card position, play my game move, then Stockfish's
    refutation line for as long as every move is a capture.
    Returns (my material after best side) - (my material after game side), or None
    if the best move is not a capture or there is no refutation line."""
    line = (m.get("best_line") or "").split()
    ref = (m.get("refutation_line") or "").split()
    board = chess.Board(m["fen_before"])
    me = board.turn
    if not line or not board.is_capture(chess.Move.from_uci(line[0])) or m.get("refutation_line") is None:
        return None
    best = _after_captures(board.copy(), line, me)
    game_board = board.copy()
    game_board.push_uci(m["my_move"])
    game = _after_captures(game_board, ref, me)
    return best - game


def is_missed_winning_capture(m: dict) -> bool:
    gain = winning_capture_gain(m)
    return gain is not None and gain >= HUNG_MIN_LOSS


def full_line_loss(m: dict) -> int | None:
    """Material I lose from the card position to the end of the stored refutation
    line (my game move, then every move of the line), or None without a line."""
    if m.get("refutation_line") is None:
        return None
    board = chess.Board(m["fen_before"])
    me = board.turn
    start = material(board, me)
    board.push_uci(m["my_move"])
    for u in m["refutation_line"].split():
        board.push_uci(u)
    return start - material(board, me)


def is_loses_material(m: dict) -> bool:
    loss = full_line_loss(m)
    return loss is not None and loss >= HUNG_MIN_LOSS


def hung_piece_loss(m: dict) -> int | None:
    """Material I lose in the capture sequence that refutes my move, or None if
    the refutation does not start by capturing one of my pieces (N, B, R, Q).

    Start: the position before my move. Play my game move, then Stockfish's
    refutation line from the refutation pass, for as long as every move in it is
    a capture (at most HUNG_MAX_PLIES plies), and compare material."""
    line = (m.get("refutation_line") or "").split()
    if not line:
        return None
    board = chess.Board(m["fen_before"])
    me = board.turn
    start = material(board, me)
    board.push_uci(m["my_move"])
    first = chess.Move.from_uci(line[0])
    target = board.piece_at(first.to_square)
    if target is None or target.color != me or target.piece_type in (chess.PAWN, chess.KING):
        return None
    for u in line[:HUNG_MAX_PLIES]:
        mv = chess.Move.from_uci(u)
        if not board.is_capture(mv):
            break
        board.push(mv)
    return start - material(board, me)


def is_hung_piece(m: dict) -> bool:
    loss = hung_piece_loss(m)
    return loss is not None and loss >= HUNG_MIN_LOSS


TAG_ORDER = ["opening", "mate", "allowed mate", "thrown win", "missed winning capture", "hung piece", "loses material"]


def tags_for(m: dict, cards: dict) -> list[str]:
    checks = {
        "opening": is_opening(m),
        "mate": is_mate(m),
        "allowed mate": is_allowed_mate(m),
        "thrown win": is_thrown_win(m, cards),
        "missed winning capture": is_missed_winning_capture(m),
        "hung piece": is_hung_piece(m),
        "loses material": is_loses_material(m),
    }
    return [t for t in TAG_ORDER if checks[t]]


def eval_text(score, color: str) -> str:
    """Engine score in pawns from `color`'s side: '+1.53', '-4.63', 'M3' (I mate in 3),
    '-M2' (I get mated in 2). Formatting only; the number is the stored score."""
    if isinstance(score, str):
        n = int(score[2:])
        mine = (score[1] == "+") == (color == "white")
        return f"{'' if mine else '-'}M{n}"
    cp = score if color == "white" else -score
    return f"{cp / 100:+.2f}"


__all__ = ["tags_for", "eval_text", "hung_piece_loss", "TAG_ORDER", "win_pct"]
