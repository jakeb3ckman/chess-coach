"""Insights from stored games and stored Stockfish output (docs/phase-3-plan.md).

Every number comes from game files (moves, clocks, results, end times) and
analysis files (pass-1 score for every position, pass-2 deep results for my
candidate moves), plus data/derived/mistakes.jsonl for tags. Tips are canned
text chosen by a fixed rule; they are never computed and never AI-written.
"""
from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .classify import win_pct
from .openings import my_move_drop, opp_move_drop

SESSION_GAP_MIN = 15          # a gap longer than this between games starts a new session
MIN_GAMES = 50                # smallest group of games a line may rest on
MIN_MOVES = 500               # smallest group of moves a rate may rest on
MIN_EVENTS = 30               # smallest count of events (gifts, thrown wins, ...) for a share
FAST_S = {"bullet": 1.0, "blitz": 2.0, "rapid": 3.0}  # "very fast" move, seconds spent
PLENTY_FRAC = 0.5             # "plenty of clock": at least half the base time left
OPENING_MOVES = 10            # speed and phase stats skip my first 10 moves (book moves are fast)
GIFT_DROP = 15.0              # an opponent move that lost >= 15 Win% (blunder level) is a gift
MISSED_DROP = 10.0            # my reply lost >= 10 Win% of it back (mistake level) = gift missed
WON = 90.0                    # "winning": Win% >= 90 (same as the card rule's thresholds)
LOST_BELOW = 50.0


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def game_duration_s(g: dict) -> float:
    """Clock time both players used: for each side, base + increment per move
    - the clock after its last move. Estimates how long the game took."""
    moves = g["moves"].split()
    clocks = g.get("clocks") or []
    total = 0.0
    for side in (0, 1):
        n = len(moves[side::2])
        cl = [c for c in clocks[side::2] if c is not None]
        if n and cl:
            total += max(0.0, g["base_s"] + g["inc_s"] * n - cl[-1])
    return total


def load_games(store) -> list[dict]:
    """One record per game with per-move facts, oldest first by start time."""
    out = []
    for g in store.iter_games():
        with open(store.analysis_path(g)) as f:
            a = json.load(f)
        p1, p2 = a["p1"], a.get("p2", {})
        me = g["my_color"]
        opp = "black" if me == "white" else "white"
        par = 0 if me == "white" else 1
        moves = g["moves"].split()
        clocks = g.get("clocks") or [None] * len(moves)
        mine, theirs = [], []
        for i, mv in enumerate(moves):
            if i % 2 == par:
                drop, src = my_move_drop(i, mv, me, p1, p2)
                before = clocks[i - 2] if i >= 2 else float(g["base_s"])
                after = clocks[i] if i < len(clocks) else None
                spent = None if before is None or after is None else max(0.0, before - after + g["inc_s"])
                mine.append({"i": i, "n": i // 2 + 1, "drop": drop, "src": src, "clk": before, "spent": spent,
                             "wb": win_pct(p1[i][0], me), "wa": win_pct(p1[i + 1][0], me)})
            else:
                theirs.append({"i": i, "drop": opp_move_drop(i, mv, opp, p1),
                               "wb_me": win_pct(p1[i][0], me), "wa_me": win_pct(p1[i + 1][0], me)})
        end = _dt(g["ended_at"])
        mine_r, opp_r = g[me].get("rating"), g[opp].get("rating")
        exp = 1 / (1 + 10 ** ((opp_r - mine_r) / 400)) if mine_r and opp_r else None
        out.append({"id": g["id"], "url": g["url"], "tc": g["time_class"], "base": g["base_s"], "color": me,
                    "expected": exp, "site": g["site"],
                    "result": g["my_result"], "termination": g["termination"], "end": end,
                    "start": end - timedelta(seconds=game_duration_s(g)), "mine": mine, "theirs": theirs})
    out.sort(key=lambda r: r["start"])
    return out


def assign_sessions(games: list[dict]) -> None:
    """A session is a run of games where each game starts no more than
    SESSION_GAP_MIN minutes after the previous one ended (both sites together).
    Adds 'session' (number) and 'k' (game number within the session, from 1)."""
    s, k, prev_end = 0, 0, None
    for g in games:
        if prev_end is None or (g["start"] - prev_end).total_seconds() > SESSION_GAP_MIN * 60:
            s, k, prev_end = s + 1, 0, g["end"]
        else:
            prev_end = max(prev_end, g["end"])
        k += 1
        g["session"], g["k"] = s, k


# ---------------------------------------------------------------- statistics

def rate(x: int, n: int) -> float | None:
    return x / n if n else None


def diff_ci(x1: int, n1: int, x2: int, n2: int) -> tuple[float, float, float]:
    """Difference of two proportions with a 95% confidence interval (normal
    approximation). Treats every item as independent, which moves within one
    game are not, so for move rates the interval is somewhat too narrow."""
    p1, p2 = x1 / n1, x2 / n2
    se = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
    d = p1 - p2
    return d, d - 1.96 * se, d + 1.96 * se


def wilson(x: int, n: int) -> tuple[float, float]:
    if not n:
        return (0.0, 0.0)
    z = 1.96
    p = x / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return c - h, c + h


def label_of(drop: float) -> str | None:
    return "blunder" if drop >= 15 else "mistake" if drop >= 10 else "inaccuracy" if drop >= 5 else None


def tilt(games: list[dict]) -> dict:
    """Loss rate in games whose two previous games in the same session were both
    losses, against all other games that have two earlier games in the session."""
    after2, other = [0, 0], [0, 0]
    bl_after, bl_other = [0, 0], [0, 0]
    xs = {"after2": [0.0, 0.0, 0], "other": [0.0, 0.0, 0]}  # score, expected score, games (rated games)
    by_session = defaultdict(list)
    for g in games:
        by_session[g["session"]].append(g)
    for ss in by_session.values():
        for j in range(2, len(ss)):
            g = ss[j]
            bucket, blb = (after2, bl_after) if ss[j - 1]["result"] == ss[j - 2]["result"] == "loss" else (other, bl_other)
            bucket[0] += g["result"] == "loss"
            bucket[1] += 1
            if g["expected"] is not None:
                x = xs["after2" if bucket is after2 else "other"]
                x[0] += {"win": 1, "draw": .5, "loss": 0}[g["result"]]
                x[1] += g["expected"]
                x[2] += 1
            blb[0] += sum(1 for m in g["mine"] if m["drop"] >= 15)
            blb[1] += len(g["mine"])
    return {"after2": after2, "other": other, "blunders_after2": bl_after, "blunders_other": bl_other, "vs_expected": xs}


def results_by(games: list[dict], key) -> dict:
    agg = defaultdict(lambda: Counter())
    for g in games:
        b = key(g)
        if b is None:
            continue
        agg[b][g["result"]] += 1
        if g["expected"] is not None:
            agg[b]["score_x2"] += {"win": 2, "draw": 1, "loss": 0}[g["result"]]
            agg[b]["exp_x1000"] += round(g["expected"] * 1000)
            agg[b]["rated_games"] += 1
        agg[b]["moves"] += len(g["mine"])
        agg[b]["blunders"] += sum(1 for m in g["mine"] if m["drop"] >= 15)
    return agg


def k_bucket(k: int) -> str:
    return "1" if k == 1 else "2" if k == 2 else "3" if k == 3 else "4-5" if k <= 5 else "6-10" if k <= 10 else "11+"


def hour_bucket(g: dict, tz: ZoneInfo) -> str:
    h = g["start"].astimezone(tz).hour
    return ["00-06", "06-12", "12-18", "18-24"][h // 6]


def speed(games: list[dict]) -> dict:
    """Per time control: blunder rate on very fast moves vs other moves, counting
    only my moves after move OPENING_MOVES with at least half the base time left."""
    out = {}
    for tc in ("bullet", "blitz", "rapid"):
        fast, slow = [0, 0], [0, 0]
        for g in games:
            if g["tc"] != tc:
                continue
            for m in g["mine"]:
                if m["n"] <= OPENING_MOVES or m["spent"] is None or m["clk"] is None:
                    continue
                if m["clk"] < PLENTY_FRAC * g["base"]:
                    continue
                b = fast if m["spent"] < FAST_S[tc] else slow
                b[0] += m["drop"] >= 15
                b[1] += 1
        out[tc] = {"fast": fast, "other": slow}
    return out


def tc_rates(games: list[dict]) -> dict:
    out = {}
    for tc in ("bullet", "blitz", "rapid"):
        c = Counter()
        for g in games:
            if g["tc"] != tc:
                continue
            c["games"] += 1
            for m in g["mine"]:
                c["moves"] += 1
                lab = label_of(m["drop"])
                if lab:
                    c[lab] += 1
        out[tc] = c
    return out


def danger(games: list[dict]) -> dict:
    """Blunder rate by move number, and by clock left (share of base time)."""
    by_n, by_clk = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
    for g in games:
        for m in g["mine"]:
            n = m["n"]
            nb = "1-10" if n <= 10 else "11-20" if n <= 20 else "21-30" if n <= 30 else "31-40" if n <= 40 else "41+"
            by_n[nb][0] += m["drop"] >= 15
            by_n[nb][1] += 1
            if m["clk"] is not None:
                f = m["clk"] / g["base"]
                cb = ">50%" if f > .5 else "20-50%" if f > .2 else "10-20%" if f > .1 else "<10%"
                by_clk[cb][0] += m["drop"] >= 15
                by_clk[cb][1] += 1
    return {"move": dict(by_n), "clock": dict(by_clk)}


def gifts(games: list[dict]) -> dict:
    """An opponent move that lost >= GIFT_DROP Win% (pass 1, their side), when I
    was not already winning (my Win% before it < WON). Missed: my very next move
    lost >= MISSED_DROP Win%. Compared with my rate of such moves elsewhere."""
    n = missed = 0
    other_moves = other_bad = 0
    for g in games:
        gift_plies = set()
        for t in g["theirs"]:
            if t["drop"] >= GIFT_DROP and t["wb_me"] < WON:
                gift_plies.add(t["i"] + 1)
        for m in g["mine"]:
            if m["i"] in gift_plies:
                n += 1
                missed += m["drop"] >= MISSED_DROP
            else:
                other_moves += 1
                other_bad += m["drop"] >= MISSED_DROP
    return {"gifts": n, "missed": missed, "other_moves": other_moves, "other_bad": other_bad}


def thrown(games: list[dict]) -> dict:
    """Games where I stood at Win% >= WON after one of my moves (pass 1) and did
    not win. 'Thrown at move n' = my first move after which I fell below
    LOST_BELOW having been >= WON earlier."""
    winning = Counter()
    thrown_by = Counter()
    how = Counter()
    stage = Counter()
    for g in games:
        peak = False
        throw_n = None
        for m in g["mine"]:
            if m["wa"] >= WON:
                peak = True
            elif peak and throw_n is None and m["wa"] < LOST_BELOW:
                throw_n = m["n"]
        if not peak:
            continue
        winning[g["tc"]] += 1
        if g["result"] == "win":
            continue
        thrown_by[g["tc"]] += 1
        t = g["termination"].lower()
        if g["result"] == "draw":
            how["drawn"] += 1
        elif "time" in t:
            how["lost on time" if throw_n is None else "blundered, then lost on time"] += 1
        else:
            how["lost on the board"] += 1
        if throw_n is not None:
            stage["1-20" if throw_n <= 20 else "21-30" if throw_n <= 30 else "31-40" if throw_n <= 40 else "41+"] += 1
        else:
            stage["never fell below 50"] += 1
    return {"winning": winning, "thrown": thrown_by, "how": how, "stage": stage}


def one_move_errors(mistakes: list[dict]) -> dict:
    """Deep-checked blunders, split by whether the position had several
    acceptable moves (second-best within 15 Win% of best: excluded from the deck
    by the 'best_not_clearly_best' rule), with the tags they carry."""
    out = {}
    for group, test in (("several fine moves", lambda m: "best_not_clearly_best" in m["excluded_by"]),
                        ("one clear best move", lambda m: m["second_best_gap"] is not None
                         and "best_not_clearly_best" not in m["excluded_by"])):
        ms = [m for m in mistakes if m["source_pass"] == 2 and m["label"] == "blunder" and test(m)]
        c = Counter()
        for m in ms:
            for t in m["tags"]:
                c[t] += 1
        c["total"] = len(ms)
        out[group] = c
    return out
