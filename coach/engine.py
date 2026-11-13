"""Stockfish analysis of one game: pass 1 on every position, pass 2 on candidates.

Repeatability: one thread, fixed node counts, and `ucinewgame` (hash cleared)
before every position, so a position's result never depends on what was
analyzed before it. The game's move history is still sent, so the engine sees
repetitions exactly as they happened in the game.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import chess
import chess.engine

from .classify import win_pct
from .config import ROOT

ANALYSIS_FORMAT = 1
DEFAULT_ENGINE = ROOT / ".engine" / "stockfish"


def engine_path() -> Path:
    return Path(os.environ.get("STOCKFISH_PATH", DEFAULT_ENGINE))


def open_engine(settings: dict) -> chess.engine.SimpleEngine:
    eng = chess.engine.SimpleEngine.popen_uci(str(engine_path()))
    eng.configure({"Threads": settings["engine"]["threads"], "Hash": settings["engine"]["hash_mb"]})
    return eng


def encode_score(pov: chess.engine.PovScore) -> int | str:
    s = pov.white()
    m = s.mate()
    if m is not None:
        return f"M+{m}" if m > 0 else f"M-{-m}"
    return s.score()


def terminal_score(board: chess.Board):
    """Score for a position with no legal moves, or None if the game goes on."""
    if board.is_checkmate():
        return "M-0" if board.turn == chess.WHITE else "M+0"  # side to move has been mated
    if board.is_stalemate():
        return 0
    return None


def _analyse(eng, board, nodes, multipv=None):
    # game=object() makes python-chess send `ucinewgame` first (clears the hash)
    kw = {"multipv": multipv} if multipv else {}
    return eng.analyse(board, chess.engine.Limit(nodes=nodes), game=object(), **kw)


def _pv(info, max_plies) -> str:
    return " ".join(m.uci() for m in info.get("pv", [])[:max_plies])


def analyze_game(game: dict, settings: dict, eng: chess.engine.SimpleEngine) -> dict:
    e = settings["engine"]
    t0 = time.monotonic()
    moves = [chess.Move.from_uci(u) for u in game["moves"].split()]
    me = game["my_color"]
    my_parity = 0 if me == "white" else 1

    # Pass 1: every position (before each move, plus the final position)
    board = chess.Board()
    boards = [board.copy()]
    for mv in moves:
        board.push(mv)
        boards.append(board.copy())
    p1, pv_cache = [], {}
    for i, b in enumerate(boards):
        ts = terminal_score(b)
        if ts is not None:
            p1.append([ts, None])
            continue
        info = _analyse(eng, b, e["pass1_nodes"])
        pv = info.get("pv", [])
        p1.append([encode_score(info["score"]), pv[0].uci() if pv else None])
        if i % 2 == my_parity:
            pv_cache[i] = _pv(info, e["pv_max_plies"])

    # Choose my moves for the deep pass
    pv1, p2 = {}, {}
    for i in range(len(moves)):
        if i % 2 != my_parity:
            continue
        before = win_pct(p1[i][0], me)
        after = win_pct(p1[i + 1][0], me)
        drop = 0.0 if moves[i].uci() == p1[i][1] else before - after
        if drop >= e["pv1_min_drop"]:
            pv1[str(i)] = pv_cache.get(i, "")
        if drop >= e["candidate_min_drop"] and before >= e["candidate_min_win_before"]:
            infos = _analyse(eng, boards[i], e["pass2_nodes"], multipv=e["pass2_multipv"])
            lines = [[encode_score(inf["score"]), inf.get("depth"), _pv(inf, e["pv_max_plies"])]
                     for inf in infos if inf.get("pv")]
            ts = terminal_score(boards[i + 1])
            if ts is not None:
                after_s, after_d = ts, None
            else:
                ai = _analyse(eng, boards[i + 1], e["pass2_nodes"])
                after_s, after_d = encode_score(ai["score"]), ai.get("depth")
            p2[str(i)] = {"lines": lines, "after": after_s, "after_d": after_d}

    return {
        "format": ANALYSIS_FORMAT,
        "engine": {
            "name": eng.id.get("name"),
            "threads": e["threads"],
            "hash_mb": e["hash_mb"],
            "pass1_nodes": e["pass1_nodes"],
            "pass2_nodes": e["pass2_nodes"],
            "pass2_multipv": e["pass2_multipv"],
            "candidate_min_drop": e["candidate_min_drop"],
            "candidate_min_win_before": e["candidate_min_win_before"],
        },
        "p1": p1,
        "pv1": pv1,
        "p2": p2,
        "secs": round(time.monotonic() - t0, 2),
    }
