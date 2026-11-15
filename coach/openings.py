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
import json
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


# ---------------------------------------------------------------- nightly build

def _res(rs) -> dict:
    c = Counter(rs)
    n = len(rs)
    return {"n": n, "w": c["win"], "d": c["draw"], "l": c["loss"],
            "score": round(100 * sum(score_of(r) for r in rs) / n, 1) if n else None}


def _expected(g: dict) -> float | None:
    me = g["my_color"]
    opp = "black" if me == "white" else "white"
    a, b = g[me].get("rating"), g[opp].get("rating")
    return 1 / (1 + 10 ** ((b - a) / 400)) if a and b else None


def trend_blocks(games: list[dict], block: int) -> list[dict]:
    """Rating-adjusted score over time: games oldest first, in blocks of `block`;
    a last block shorter than half a block joins the one before it. Per block:
    score, expected score (Elo formula on the two stored ratings) and their
    difference with a 95% interval (mean +- 1.96 standard errors)."""
    import math
    gs = sorted((g for g in games if _expected(g) is not None), key=lambda g: g["ended_at"])
    chunks = [gs[i:i + block] for i in range(0, len(gs), block)]
    if len(chunks) > 1 and len(chunks[-1]) < block / 2:
        chunks[-2].extend(chunks.pop())
    out = []
    for ch in chunks:
        r = [score_of(g["my_result"]) - _expected(g) for g in ch]
        m = sum(r) / len(r)
        sd = math.sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1)) if len(r) > 1 else 0.0
        h = 1.96 * sd / math.sqrt(len(r))
        out.append({"from": ch[0]["ended_at"][:10], "to": ch[-1]["ended_at"][:10], "games": len(ch),
                    "score": round(100 * sum(score_of(g["my_result"]) for g in ch) / len(ch), 1),
                    "expected": round(100 * sum(_expected(g) for g in ch) / len(ch), 1),
                    "diff": round(100 * m, 1), "lo": round(100 * (m - h), 1), "hi": round(100 * (m + h), 1)})
    return out


def node_key(color: str, epd: str) -> str:
    import hashlib
    return hashlib.sha1(f"{color}|{epd}".encode()).hexdigest()[:12]


def game_link_at(g: dict, ply: int) -> str:
    if g["site"] == "lichess":
        return f"{g['url']}/{g['my_color']}#{ply}"
    return g["url"]


def _san_path(moves: list[str], upto: int) -> str:
    b = chess.Board()
    out = []
    for i, mv in enumerate(moves[:upto]):
        m = chess.Move.from_uci(mv)
        s = b.san(m)
        out.append(f"{i // 2 + 1}.{s}" if i % 2 == 0 else (f"{i // 2 + 1}...{s}" if not out else s))
        b.push(m)
    return " ".join(out)


def move_scores(pos: dict) -> dict[str, dict]:
    """From a position-pass record: uci -> {score, pv} for every searched move
    (the top-5 lines and the extra restricted searches)."""
    out = {}
    for score, _depth, pv in pos["lines"]:
        if pv:
            out[pv.split()[0]] = {"score": score, "pv": pv}
    for mv, e in pos.get("extra", {}).items():
        out.setdefault(mv, {"score": e["score"], "pv": e["pv"]})
    return out


def build_openings(games: list[dict], data_dir: Path, settings: dict, tactic_epds: set[str]) -> tuple[dict, list[dict]]:
    """Everything the Openings screen shows, plus the leak cards.
    games: game dicts (as stored). Returns (openings.json content, leak cards
    in the app's card format, ordered by total Win% lost)."""
    from .positions import load_position
    from .tags import eval_text
    os_ = settings["openings"]
    ps = settings["positions"]
    max_ply = ps["max_ply"]

    for g in games:
        g["_m"] = g["moves"].split()
        g["_name"] = name_game(g["_m"])

    # ---- repertoire groups
    groups_out = {}
    table = opening_table()
    name_pos = {}  # opening name -> epd of its table line
    for epd, (_eco, name, _n) in table.items():
        name_pos.setdefault(name, epd)
    for color in ("white", "black"):
        gs = [g for g in games if g["my_color"] == color]
        vcount = Counter(variation(g["_name"][1]) for g in gs if g["_name"])
        groups = defaultdict(list)
        for g in gs:
            if not g["_name"]:
                groups[("(no name)", None)].append(g)
                continue
            v = variation(g["_name"][1])
            fam = family(g["_name"][1])
            groups[(v, v) if vcount[v] >= os_["group_min_games"] else (f"{fam} (other lines)", fam)].append(g)
        rows = []
        for (label, anchor), gg in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            for g in gg:
                g["_group"] = label  # used by Progress and to tag cards with their opening
            epd = name_pos.get(anchor) if anchor else None
            row = {"name": label, "family": family(label.replace(" (other lines)", "")), **_res([g["my_result"] for g in gg]),
                   "tc": {tc: _res([g["my_result"] for g in gg if g["time_class"] == tc])
                          for tc in ("bullet", "blitz", "rapid")},
                   "node": node_key(color, epd) if epd else None, "eco": gg[0]["_name"][0] if gg[0]["_name"] else None}
            if len(gg) >= os_["trend_min_games"]:
                row["trend"] = trend_blocks(gg, os_["trend_block"])
            rows.append(row)
        groups_out[color] = rows

    # ---- move tree: positions in my first 15 moves (both sides to move) reached >= tree_min_games times
    occ = defaultdict(list)  # (color, epd) -> [(game, ply)]
    for g in games:
        b = chess.Board()
        for i, mv in enumerate(g["_m"][:max_ply]):
            occ[(g["my_color"], b.epd())].append((g, i))
            b.push_uci(mv)
    keep = {k for k, v in occ.items() if len({x[0]["id"] for x in v}) >= os_["tree_min_games"]}
    nodes = {}
    leaks = []
    cards = []
    node_info = {}  # node -> (board, Win% behind best per searched move, occurrences), for Progress
    for (color, epd) in keep:
        oo = occ[(color, epd)]
        g0, i0 = max(oo, key=lambda x: x[0]["ended_at"])
        b = chess.Board()
        for mv in g0["_m"][:i0]:
            b.push_uci(mv)
        me_to_move = (b.turn == chess.WHITE) == (color == "white")
        by_move = defaultdict(list)
        for g, i in oo:
            by_move[g["_m"][i]].append((g, i))
        moves = []
        for mv, xs in sorted(by_move.items(), key=lambda kv: -len(kv[1])):
            nb = b.copy()
            nb.push_uci(mv)
            child = (color, nb.epd())
            moves.append({"u": mv, "s": b.san(chess.Move.from_uci(mv)), **_res([g["my_result"] for g, _ in xs]),
                          "to": node_key(*child) if child in keep else None})
        name = name_game(g0["_m"][:i0])
        node = {"fen": b.fen(), "color": color, "me": me_to_move, "games": len({g["id"] for g, _ in oo}),
                "path": _san_path(g0["_m"], i0), "name": name[1] if name else None, "moves": moves[:10]}
        if me_to_move:
            # Side by side: my usual move, the best-scoring other move I've played
            # (alt_min_games+), and the engine's best move if I've played it that often.
            usual = moves[0]
            alts = [m for m in moves[1:] if m["n"] >= os_["alt_min_games"] and m["score"] > usual["score"]]
            cmp = {"usual": usual["u"], "alt": max(alts, key=lambda m: m["score"])["u"] if alts else None, "engine": None}
            pos = load_position(data_dir, epd) if node["games"] >= ps["min_games"] else None
            if pos and pos["lines"][0][2]:
                eb = pos["lines"][0][2].split()[0]
                if eb not in (cmp["usual"], cmp["alt"]) and any(m["u"] == eb and m["n"] >= os_["alt_min_games"] for m in moves):
                    cmp["engine"] = eb
            if usual["n"] >= os_["alt_min_games"] and (cmp["alt"] or cmp["engine"]):
                node["compare"] = cmp
            if pos:
                sc = move_scores(pos)
                best_score = pos["lines"][0][0]
                wb = win_pct(best_score, color)
                behind = {u: round(wb - win_pct(v["score"], color), 1) for u, v in sc.items()}
                if node["games"] >= os_["engine_top_min_games"]:
                    node["engine"] = [{"u": pv.split()[0], "s": b.san(chess.Move.from_uci(pv.split()[0])),
                                       "behind": behind[pv.split()[0]], "eval": eval_text(score, color)}
                                      for score, _d, pv in pos["lines"][:3] if pv]
                for m in moves:
                    if m["u"] in behind:
                        m["behind"] = behind[m["u"]]
                complete = len(pos["lines"]) < ps["multipv"] or behind[pos["lines"][-1][2].split()[0]] > os_["right_within"]
                node_info[node_key(color, epd)] = (b.copy(), behind, oo, complete)
                # ---- leaks at this position
                best_u = pos["lines"][0][2].split()[0]
                for m in moves:
                    if m["n"] < ps["min_played_for_extra"] or m["u"] not in behind:
                        continue
                    drop = behind[m["u"]]
                    if drop < os_["leak_min_drop"] or not (10 <= wb <= 90):
                        continue
                    xs = by_move[m["u"]]
                    best_rec = [r for r in moves if r["u"] == best_u]
                    kind = "error" if drop >= os_["leak_error_drop"] else "repertoire"
                    lk = {"node": node_key(color, epd), "color": color, "path": node["path"], "name": node["name"],
                          "fen": b.fen(), "kind": kind, "move": m["u"], "move_san": m["s"], "best": best_u,
                          "best_san": b.san(chess.Move.from_uci(best_u)), "drop": drop, "played": m["n"],
                          "reached": node["games"], "total": round(drop * m["n"], 1),
                          "mine": {k: m[k] for k in ("n", "w", "d", "l", "score")},
                          "best_rec": {k: best_rec[0][k] for k in ("n", "w", "d", "l", "score")} if best_rec else _res([]),
                          "links": [game_link_at(g, i) for g, i in sorted(xs, key=lambda x: x[0]["ended_at"], reverse=True)[:3]],
                          "card": None}
                    if kind == "error":
                        top_complete = len(pos["lines"]) < ps["multipv"] or behind[pos["lines"][-1][2].split()[0]] > os_["right_within"]
                        lk["no_card"] = ("a tactics card already covers this position" if epd in tactic_epds
                                         else None if top_complete else "more than 4 moves are within 2 Win%")
                    leaks.append(lk)
                # One leak card per position, covering every error move I played there.
                errs = [lk for lk in leaks if lk["node"] == node_key(color, epd) and lk["kind"] == "error" and not lk.get("no_card")]
                if errs:
                    card = _leak_card(b, epd, color, pos, sc, behind, [lk["move"] for lk in errs],
                                      [x for lk in errs for x in by_move[lk["move"]]], os_, eval_text)
                    for lk in errs:
                        lk["card"] = card["id"]
                    cards.append((sum(lk["total"] for lk in errs), card))
        nodes[node_key(color, epd)] = node

    replies = []
    for (color, epd) in keep:
        n = nodes[node_key(color, epd)]
        if n["me"] or n["games"] < 20:
            continue
        for m in n["moves"]:
            replies.append({"color": color, "after": n["path"] or "(start)", "node": node_key(color, epd),
                            "reply": m["s"], "of": n["games"], **{k: m[k] for k in ("n", "w", "d", "l", "score")},
                            "to": m["to"]})
    replies.sort(key=lambda r: -r["n"])
    leaks.sort(key=lambda r: -r["total"])
    cards.sort(key=lambda tc: -tc[0])
    progress = build_progress(games, groups_out, leaks, node_info, data_dir, settings)
    starts = {c: node_key(c, chess.Board().epd()) for c in ("white", "black")}
    out = {"format": 1, "games": len(games), "groups": groups_out, "replies": replies[:30], "leaks": leaks,
           "nodes": nodes, "start": starts, "progress": progress,
           "rules": {k: os_[k] for k in ("leak_min_drop", "leak_error_drop", "right_within", "playable_within",
                                          "group_min_games", "trend_block")}}
    return out, [c for _, c in cards]


def build_progress(games: list[dict], groups_out: dict, leaks: list[dict], node_info: dict, data_dir: Path,
                   settings: dict) -> dict:
    """Progress since the training start date (settings [progress]), per opening
    group, from stored games and stored engine output only (no new engine work):
      - blunders per 100 moves in my first 15 moves (my moves losing >= 15 Win%,
        deep pass where stored, as for mistakes), before and since;
      - each leak position (error or repertoire choice) of the group: how often I
        played a good move (within right_within Win% of the best, by the position
        pass), one of my old leak moves, another searched move, or a move the
        pass didn't search where the list of good moves may be incomplete.
    A game counts as 'since' when it ended on or after the start date (local time).
    A position belongs to the group most of its games belong to.
    Card statuses per opening are computed in the app from the reviews."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(settings["insights"]["timezone"])
    start = settings["progress"]["training_start"]
    right = settings["openings"]["right_within"]
    max_ply = settings["positions"]["max_ply"]

    def period(g):
        d = datetime.fromisoformat(g["ended_at"].replace("Z", "+00:00")).astimezone(tz).date().isoformat()
        return "since" if d >= start else "before"

    rows = {(c, r["name"]): r for c in groups_out for r in groups_out[c]}
    blund = defaultdict(lambda: {"before": Counter(), "since": Counter()})
    for g in games:
        p = data_dir / "analysis" / g["site"] / g["ended_at"][:7] / f"{g['site_id']}.json"
        if not p.exists() or "_group" not in g:
            continue
        with open(p) as f:
            a = json.load(f)
        me = g["my_color"]
        par = 0 if me == "white" else 1
        c = blund[(me, g["_group"])][period(g)]
        c["games"] += 1
        for i, mv in enumerate(g["_m"][:max_ply]):
            if i % 2 == par:
                c["moves"] += 1
                c["blunders"] += my_move_drop(i, mv, me, a["p1"], a.get("p2", {}))[0] >= 15
    for key, row in rows.items():
        bc = blund.get(key, {"before": Counter(), "since": Counter()})
        row["progress"] = {"blunders": {k: {"blunders": v["blunders"], "moves": v["moves"], "games": v["games"]}
                                        for k, v in bc.items()}, "leaks": []}

    by_node = defaultdict(list)
    for lk in leaks:
        by_node[lk["node"]].append(lk)
    for nk, lks in by_node.items():
        b, behind, oo, complete = node_info[nk]
        color = lks[0]["color"]
        old = {lk["move"] for lk in lks}
        good = {u for u, d in behind.items() if d <= right}
        cnt = {"before": Counter(), "since": Counter()}
        grp = Counter()
        for g, i in oo:
            mv = g["_m"][i]
            c = cnt[period(g)]
            c["n"] += 1
            # 'unchecked': a move the position pass didn't search, where 5 searched
            # moves were all good, so it may be good too.
            c["good" if mv in good else "old" if mv in old else
              "other" if (mv in behind or complete) else "unchecked"] += 1
            grp[g.get("_group")] += 1
        row = rows.get((color, grp.most_common(1)[0][0]))
        if row is None:
            continue
        san = lambda u: b.san(chess.Move.from_uci(u))  # noqa: E731
        row["progress"]["leaks"].append({
            "node": nk, "path": lks[0]["path"], "kinds": sorted({lk["kind"] for lk in lks}),
            "old": [san(u) for u in sorted(old, key=lambda u: -behind.get(u, 0))],
            "good": [san(u) for u in sorted(good, key=lambda u: behind[u])],
            "good_complete": complete,
            "before": {k: cnt["before"][k] for k in ("n", "good", "old", "other", "unchecked")},
            "since": {k: cnt["since"][k] for k in ("n", "good", "old", "other", "unchecked")}})
    for row in rows.values():
        # Positions reached since the start date first, most often reached first.
        row["progress"]["leaks"].sort(key=lambda x: (-x["since"]["n"], -x["before"]["n"]))
    return {"start": start, "min_games_since": settings["progress"]["min_games_since"],
            "right_within": right}


def _leak_card(b: chess.Board, epd: str, color: str, pos: dict, sc: dict, behind: dict, leak_moves: list[str],
               xs: list, os_: dict, eval_text) -> dict:
    """A leak card in the app's card format (deck 'opening'). The game move shown
    is the error move I played most often there; every occurrence of every error
    move is listed, so any of them counts as a habit."""
    import hashlib
    from .classify import label as label_of
    best_score, _d, best_pv = pos["lines"][0]
    g, i = max(xs, key=lambda x: x[0]["ended_at"])
    played = Counter(gg["_m"][ii] for gg, ii in xs)
    leak = max(leak_moves, key=lambda u: (played[u], behind[u]))
    mine = sc[leak]
    ref = " ".join(mine["pv"].split()[1:]) or None
    labels = {"inaccuracy": 5.0, "mistake": 10.0, "blunder": 15.0}
    return {
        "id": hashlib.sha1(f"{epd}|leak".encode()).hexdigest()[:12],
        "deck": "opening",
        "fen": b.fen(),
        "solution": best_pv.split()[0],
        "line": best_pv,
        "color": color,
        "prev": g["_m"][i - 1] if i > 0 else None,
        "tags": (["opening"] if b.fullmove_number <= 10 else []) + ["repeated opening error"],
        "best_eval": eval_text(best_score, color),
        "game": {"move": leak, "eval": eval_text(mine["score"], color), "refutation": ref,
                 "win_before": round(win_pct(best_score, color), 1), "win_after": round(win_pct(mine["score"], color), 1),
                 "move_number": b.fullmove_number},
        "occ": [{"link": game_link_at(gg, ii), "site": gg["site"], "move": gg["_m"][ii], "drop": behind[gg["_m"][ii]],
                 "label": label_of(behind[gg["_m"][ii]], labels), "tc": gg["time_class"], "at": gg["ended_at"][:10]}
                for gg, ii in sorted(xs, key=lambda x: x[0]["ended_at"], reverse=True)],
        "opening": g.get("_group"),
        "right": sorted((u for u, d in behind.items() if d <= os_["right_within"]), key=lambda u: behind[u]),
        "alts": [{"u": u, "behind": behind[u], "eval": eval_text(sc[u]["score"], color)}
                 for u in sorted(behind, key=lambda u: behind[u])],
    }
