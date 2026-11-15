"""Opening names, repertoire, opponents' replies and opening leaks.

Everything here is computed from stored games and stored Stockfish output.

Opening names come from the CC0 table lichess-org/chess-openings (vendored in
config/chess-openings/, commit noted in its README). A game gets the name of
the LAST position in its first 40 plies that appears in the table, matched by
position (pieces, side to move, castling, legal en passant), so transpositions
get the same name. This is how Lichess names openings.

Grouping (so the list isn't hundreds of sub-variations):
  family    = the name before the first ':'   e.g. "Sicilian Defense"
  variation = the name before the first ','   e.g. "Sicilian Defense: Najdorf Variation"
"""
from __future__ import annotations

import csv
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path

import chess

from .classify import win_pct

ROOT = Path(__file__).resolve().parent.parent
TABLE_DIR = ROOT / "config" / "chess-openings"
MAX_NAME_PLY = 40


@lru_cache(maxsize=1)
def opening_table() -> dict[str, tuple[str, str, int]]:
    """EPD -> (eco, name, plies). Where two entries share a position, the one
    with fewer moves wins (the table's main name for it)."""
    out: dict[str, tuple[str, str, int]] = {}
    for p in sorted(TABLE_DIR.glob("*.tsv")):
        with open(p, newline="") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                b = chess.Board()
                n = 0
                for tok in row["pgn"].split():
                    if tok[0].isdigit():
                        continue
                    b.push_san(tok)
                    n += 1
                key = b.epd()
                if key not in out or n < out[key][2]:
                    out[key] = (row["eco"], row["name"], n)
    return out


def name_game(moves: list[str]) -> tuple[str, str, int] | None:
    """(eco, name, ply where the name was last matched) or None."""
    table = opening_table()
    b = chess.Board()
    found = None
    for i, mv in enumerate(moves[:MAX_NAME_PLY]):
        b.push_uci(mv)
        hit = table.get(b.epd())
        if hit:
            found = (hit[0], hit[1], i + 1)
    return found


def family(name: str) -> str:
    return name.split(":")[0].strip()


def variation(name: str) -> str:
    return name.split(",")[0].strip()


def score_of(result: str) -> float:
    return {"win": 1.0, "draw": 0.5, "loss": 0.0}[result]


# ---------------------------------------------------------------- per-game moves

def my_move_drop(i: int, mv: str, me: str, p1: list, p2: dict) -> tuple[float, int]:
    """Win% I lost with my move at ply i, exactly as derive_mistakes computes it
    (deep pass when stored, else pass 1). Returns (drop, source_pass)."""
    deep = p2.get(str(i))
    if deep and deep["lines"]:
        best_score, best_line, after = deep["lines"][0][0], deep["lines"][0][2], deep["after"]
        src = 2
    else:
        best_score, best_line, after = p1[i][0], p1[i][1] or "", p1[i + 1][0]
        src = 1
    best = best_line.split()[0] if best_line else p1[i][1]
    if mv == best:
        return 0.0, src
    return max(0.0, win_pct(best_score, me) - win_pct(after, me)), src


def opp_move_drop(i: int, mv: str, opp: str, p1: list) -> float:
    """Win% the opponent lost with their move at ply i (pass 1 only: opponents'
    moves never get a deep check)."""
    if mv == p1[i][1]:
        return 0.0
    return max(0.0, win_pct(p1[i][0], opp) - win_pct(p1[i + 1][0], opp))
