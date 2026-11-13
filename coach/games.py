"""Normalize games from both sites into one compact format.

Normalized game (one JSON object, written once to data/games/...):
  id, site, site_id, url, ended_at (UTC ISO), time_class, base_s, inc_s, rated,
  my_color, white{name,rating}, black{name,rating}, result, my_result,
  termination, moves (space-separated UCI), clocks (seconds left after each
  half-move, or null where the PGN has no clock).
"""
from __future__ import annotations

import io
from datetime import datetime, timezone

import chess
import chess.pgn

STANDARD_START = chess.STARTING_FEN


class SkipGame(Exception):
    """Raised when a game is out of scope (variant, custom start, no moves...)."""


def parse_pgn_moves(pgn_text: str) -> tuple[list[str], list[float | None], dict]:
    """Return (uci moves, clocks after each move, headers) using python-chess."""
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        raise SkipGame("unreadable PGN")
    if game.errors:
        raise SkipGame(f"PGN errors: {game.errors[0]}")
    headers = dict(game.headers)
    fen = headers.get("FEN")
    if fen and fen != STANDARD_START:
        raise SkipGame("custom start position")
    moves, clocks = [], []
    for node in game.mainline():
        moves.append(node.move.uci())
        clk = node.clock()
        clocks.append(round(clk, 1) if clk is not None else None)
    return moves, clocks, headers


def parse_time_control(tc: str) -> tuple[int, int]:
    """'600' -> (600, 0); '120+1' -> (120, 1). Raises SkipGame for daily ('1/86400')."""
    if "/" in tc or tc in ("-", ""):
        raise SkipGame(f"not a clock game: {tc}")
    if "+" in tc:
        base, inc = tc.split("+", 1)
        return int(base), int(inc)
    return int(tc), 0


def my_result(result: str, my_color: str) -> str:
    if result == "1/2-1/2":
        return "draw"
    if result == "1-0":
        return "win" if my_color == "white" else "loss"
    if result == "0-1":
        return "win" if my_color == "black" else "loss"
    return "unknown"


def iso_utc(ts_seconds: float) -> str:
    return datetime.fromtimestamp(ts_seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_chesscom(g: dict, username: str, time_classes: list[str]) -> dict:
    """Chess.com monthly-archive game object -> normalized game."""
    if g.get("rules") != "chess":
        raise SkipGame(f"variant {g.get('rules')}")
    if g.get("time_class") not in time_classes:
        raise SkipGame(f"time class {g.get('time_class')}")
    if g.get("initial_setup") and g["initial_setup"] != STANDARD_START:
        raise SkipGame("custom start position")
    base, inc = parse_time_control(g["time_control"])
    moves, clocks, headers = parse_pgn_moves(g["pgn"])
    if not moves:
        raise SkipGame("no moves")
    white, black = g["white"], g["black"]
    u = username.lower()
    if white["username"].lower() == u:
        color = "white"
    elif black["username"].lower() == u:
        color = "black"
    else:
        raise SkipGame("not my game")
    site_id = g["url"].rstrip("/").split("/")[-1]
    result = headers.get("Result", "*")
    return {
        "id": f"chesscom:{site_id}",
        "site": "chesscom",
        "site_id": site_id,
        "url": g["url"],
        "ended_at": iso_utc(g["end_time"]),
        "time_class": g["time_class"],
        "base_s": base,
        "inc_s": inc,
        "rated": bool(g.get("rated", True)),
        "my_color": color,
        "white": {"name": white["username"], "rating": white.get("rating")},
        "black": {"name": black["username"], "rating": black.get("rating")},
        "result": result,
        "my_result": my_result(result, color),
        "termination": headers.get("Termination", ""),
        "moves": " ".join(moves),
        "clocks": clocks,
    }


def normalize_lichess(g: dict, username: str, time_classes: list[str]) -> dict:
    """Lichess NDJSON game object (requested with pgnInJson=true&clocks=true) -> normalized game."""
    if g.get("variant") != "standard":
        raise SkipGame(f"variant {g.get('variant')}")
    if g.get("speed") not in time_classes:
        raise SkipGame(f"speed {g.get('speed')}")
    if g.get("source") == "ai":
        raise SkipGame("game against the computer")
    if g.get("status") in ("created", "started", "aborted", "noStart"):
        raise SkipGame(f"status {g.get('status')}")
    players = g["players"]
    for side in ("white", "black"):
        if "user" not in players[side]:
            raise SkipGame("game against the computer or anonymous player")
    clock = g.get("clock") or {}
    if "initial" not in clock:
        raise SkipGame("no clock")
    moves, clocks, headers = parse_pgn_moves(g["pgn"])
    if not moves:
        raise SkipGame("no moves")
    u = username.lower()
    if players["white"]["user"]["id"] == u or players["white"]["user"]["name"].lower() == u:
        color = "white"
    elif players["black"]["user"]["id"] == u or players["black"]["user"]["name"].lower() == u:
        color = "black"
    else:
        raise SkipGame("not my game")
    result = headers.get("Result", "*")
    return {
        "id": f"lichess:{g['id']}",
        "site": "lichess",
        "site_id": g["id"],
        "url": f"https://lichess.org/{g['id']}",
        "ended_at": iso_utc(g["lastMoveAt"] / 1000),
        "time_class": g["speed"],
        "base_s": int(clock["initial"]),
        "inc_s": int(clock["increment"]),
        "rated": bool(g["rated"]),
        "my_color": color,
        "white": {"name": players["white"]["user"]["name"], "rating": players["white"].get("rating")},
        "black": {"name": players["black"]["user"]["name"], "rating": players["black"].get("rating")},
        "result": result,
        "my_result": my_result(result, color),
        "termination": g.get("status", ""),
        "moves": " ".join(moves),
        "clocks": clocks,
    }
