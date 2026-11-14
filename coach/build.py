"""Derive mistakes and cards from stored games + analysis (no engine calls).

Everything here is rebuilt from scratch on every run, so changing a card
setting never needs re-analysis.
"""
from __future__ import annotations

import hashlib
import json

from pathlib import Path

import chess

from .classify import card_exclusions, label, win_pct
from .store import Store


def derive_mistakes(game: dict, analysis: dict, settings: dict) -> list[dict]:
    labels, cards = settings["labels"], settings["cards"]
    me = game["my_color"]
    my_parity = 0 if me == "white" else 1
    moves = game["moves"].split()
    clocks = game.get("clocks") or [None] * len(moves)
    p1, pv1, p2 = analysis["p1"], analysis.get("pv1", {}), analysis.get("p2", {})
    board = chess.Board()
    out = []
    for i, mv in enumerate(moves):
        if i % 2 == my_parity:
            deep = p2.get(str(i))
            if deep and deep["lines"]:
                lines = deep["lines"]
                best_score, best_line = lines[0][0], lines[0][2]
                after_score = deep["after"]
                source = 2
                gap = (win_pct(lines[0][0], me) - win_pct(lines[1][0], me)) if len(lines) > 1 else None
            else:
                best_score, best_line = p1[i][0], pv1.get(str(i), p1[i][1] or "")
                after_score = p1[i + 1][0]
                source, gap = 1, None
            best_move = best_line.split()[0] if best_line else p1[i][1]
            wb, wa = win_pct(best_score, me), win_pct(after_score, me)
            drop = 0.0 if mv == best_move else max(0.0, wb - wa)
            lab = label(drop, labels)
            if lab is not None:
                clk_after = clocks[i] if i < len(clocks) else None
                if i >= 2:
                    clk_before = clocks[i - 2]
                else:
                    clk_before = float(game["base_s"])
                spent = None
                if clk_before is not None and clk_after is not None:
                    spent = round(max(0.0, clk_before - clk_after + game["inc_s"]), 1)
                m = {
                    "game_id": game["id"],
                    "url": game["url"],
                    "site": game["site"],
                    "ended_at": game["ended_at"],
                    "time_class": game["time_class"],
                    "base_s": game["base_s"],
                    "inc_s": game["inc_s"],
                    "my_color": me,
                    "ply": i,
                    "move_number": i // 2 + 1,
                    "fen_before": board.fen(),
                    "position_key": board.epd(),
                    "my_move": mv,
                    "prev_move": moves[i - 1] if i > 0 else None,
                    "my_move_san": board.san(chess.Move.from_uci(mv)),
                    "best_move": best_move,
                    "best_line": best_line,
                    "score_before": best_score,
                    "score_after": after_score,
                    "win_before": round(wb, 1),
                    "win_after": round(wa, 1),
                    "drop": round(drop, 1),
                    "label": lab,
                    "second_best_gap": round(gap, 1) if gap is not None else None,
                    "clock_before_s": clk_before,
                    "time_spent_s": spent,
                    "source_pass": source,
                }
                m["excluded_by"] = card_exclusions(m, cards)
                out.append(m)
        board.push_uci(mv)
    return out


def build_cards(mistakes: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for m in mistakes:
        if not m["excluded_by"]:
            groups.setdefault(m["position_key"], []).append(m)
    cards = []
    for key, occ in groups.items():
        occ.sort(key=lambda m: m["ended_at"], reverse=True)
        latest = occ[0]
        solutions = {m["best_move"] for m in occ}
        cards.append({
            "card_id": hashlib.sha1(f"{key}|{latest['best_move']}".encode()).hexdigest()[:12],
            "deck": "tactics",
            "fen": latest["fen_before"],
            "solution_uci": latest["best_move"],
            "engine_line": latest["best_line"],
            "my_color": latest["my_color"],
            "prev_move": latest["prev_move"],
            "occurrences": [{"game_id": m["game_id"], "url": m["url"], "ply": m["ply"],
                             "my_move": m["my_move"], "drop": m["drop"], "label": m["label"],
                             "time_class": m["time_class"], "ended_at": m["ended_at"]} for m in occ],
            "n_occurrences": len(occ),
            "latest_at": latest["ended_at"],
            "max_drop": max(m["drop"] for m in occ),
            "solution_conflict": len(solutions) > 1,
        })
    return order_new_cards(cards)


def order_new_cards(cards: list[dict]) -> list[dict]:
    """Approved order: occurrences, then recency, then drop size (all descending)."""
    return sorted(cards, key=lambda c: (c["n_occurrences"], c["latest_at"], c["max_drop"]), reverse=True)


def game_link(occ: dict, my_color: str) -> str:
    """Link to the original game. Lichess can open at the move (the anchor is the
    number of half-moves played, so #ply shows the position before my move)."""
    if occ["url"].startswith("https://lichess.org/"):
        return f"{occ['url']}/{my_color}#{occ['ply']}"
    return occ["url"]


APP_CARDS_FORMAT = 1


def app_cards(cards: list[dict]) -> dict:
    """The only card file the app downloads: just what a card needs, in the
    approved new-card order (list order = introduction order)."""
    return {
        "format": APP_CARDS_FORMAT,
        "cards": [{
            "id": c["card_id"],
            "deck": c["deck"],
            "fen": c["fen"],
            "solution": c["solution_uci"],
            "line": c["engine_line"],
            "color": c["my_color"],
            "prev": c["prev_move"],
            "occ": [{"link": game_link(o, c["my_color"]), "site": o["game_id"].split(":")[0],
                     "move": o["my_move"], "drop": o["drop"], "label": o["label"],
                     "tc": o["time_class"], "at": o["ended_at"][:10]} for o in c["occurrences"]],
        } for c in cards],
    }


def build_all(store: Store, settings: dict, app_out=None) -> dict:
    mistakes, n_games, n_analyzed = [], 0, 0
    for g in store.iter_games():
        n_games += 1
        a = store.load_analysis(g)
        if a is None:
            continue
        n_analyzed += 1
        mistakes.extend(derive_mistakes(g, a, settings))
    cards = build_cards(mistakes)
    store.derived.mkdir(parents=True, exist_ok=True)
    with open(store.derived / "mistakes.jsonl", "w") as f:
        for m in mistakes:
            f.write(json.dumps(m, separators=(",", ":")) + "\n")
    Store.write_json_atomic(store.derived / "cards.json", cards)
    if app_out is not None:
        Store.write_json_atomic(Path(app_out), app_cards(cards))
    return {"games": n_games, "analyzed": n_analyzed, "mistakes": len(mistakes), "cards": len(cards)}
