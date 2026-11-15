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
        if not store.analysis_path(g).exists():
            continue  # not analyzed yet; it joins the insights the night it is
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


# ---------------------------------------------------------------- nightly build

UNDECIDED = (10.0, 90.0)
BOOT = 1000          # resamples of whole games for move-level intervals
BOOT_SEED = 20261115  # fixed, so the nightly file is identical for identical data


def _undecided(m: dict) -> bool:
    return UNDECIDED[0] <= m["wb"] <= UNDECIDED[1]


def boot_diff(a: list[tuple[int, int]], b: list[tuple[int, int]]) -> tuple[float, float, float]:
    """Difference of two pooled rates (events / items), each group given as one
    (events, items) pair per game, with a 95% interval from resampling whole
    games (so moves of one game stay together)."""
    import random
    rng = random.Random(BOOT_SEED)

    def pooled(xs):
        n = sum(x[1] for x in xs)
        return sum(x[0] for x in xs) / n if n else 0.0
    d0 = pooled(a) - pooled(b)
    ds = sorted(pooled(rng.choices(a, k=len(a))) - pooled(rng.choices(b, k=len(b))) for _ in range(BOOT))
    return d0, ds[int(0.025 * BOOT)], ds[int(0.975 * BOOT) - 1]


def _per_game(games, tc=None, test=lambda m: True, event=lambda m: m["drop"] >= 15):
    out = []
    for g in games:
        if tc and g["tc"] != tc:
            continue
        ms = [m for m in g["mine"] if _undecided(m) and test(m)]
        if ms:
            out.append((sum(1 for m in ms if event(m)), len(ms)))
    return out


def _f(x: float, nd: int = 1) -> str:
    return f"{x:.{nd}f}"


def _resid_ci(gs: list[dict]) -> tuple[int, float, float, float]:
    r = [{"win": 1, "draw": .5, "loss": 0}[g["result"]] - g["expected"] for g in gs if g["expected"] is not None]
    if len(r) < 2:
        return len(r), 0.0, 0.0, 0.0
    m = sum(r) / len(r)
    sd = math.sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1))
    h = 1.96 * sd / math.sqrt(len(r))
    return len(r), 100 * m, 100 * (m - h), 100 * (m + h)


TIPS = {
    "danger": "Your games most often turn just after the opening. When development is done, slow down and check every capture and check before you move.",
    "gifts": "When your opponent's move surprises you, first ask what it leaves undefended or allows.",
    "thrown": "When you're winning, trade pieces, keep your king safe, and watch the clock: a won position still has to be finished in time.",
    "several": "Most blunders here weren't hard positions. Before each move, check what the moved piece leaves undefended and whether it can be taken.",
    "tc": "In rapid you have time for a blunder check on every move: what does my move leave undefended, and what are their checks and captures?",
    "tilt": "After two losses in a row, take a short break before the next game.",
    "gameno": "Notice when in a session your results change, and stop before that point.",
    "hour": "Play your important games at the time of day your results are best.",
}


def build_insights(games: list[dict], mistakes: list[dict], settings: dict) -> dict:
    """The Insights screen. Each line: a statistic computed from stored data, the
    sample behind it, and a canned tip (fixed text, chosen by which line it is).
    status 'shown' = passes its sample threshold and, for a comparison, a 95%
    interval excluding zero; 'checked' = computed, no clear pattern."""
    from zoneinfo import ZoneInfo
    global SESSION_GAP_MIN
    SESSION_GAP_MIN = settings["insights"]["session_gap_min"]
    assign_sessions(games)
    tz = ZoneInfo(settings["insights"]["timezone"])
    lines = []

    # 1. danger zone
    buckets = [("1-10", 1, 10), ("11-20", 11, 20), ("21-30", 21, 30), ("31-40", 31, 40), ("41+", 41, 10_000)]
    per = {b: _per_game(games, test=lambda m, lo=lo, hi=hi: lo <= m["n"] <= hi) for b, lo, hi in buckets}
    rates = {b: (sum(x[0] for x in v), sum(x[1] for x in v)) for b, v in per.items()}
    peak = max(("11-20", "21-30"), key=lambda b: rates[b][0] / max(1, rates[b][1]))
    d, lo, hi = boot_diff(per[peak], per["1-10"])
    ok = all(n >= MIN_MOVES for _, n in rates.values())
    lines.append({
        "id": "danger", "title": "Danger zone: where games turn",
        "stat": "Blunders per 100 moves, in positions still in the balance: " + ", ".join(
            f"moves {b.replace('-', '–')}: {_f(100 * x / n)}" for b, (x, n) in rates.items()) + ".",
        "sample": f"{sum(n for _, n in rates.values()):,} moves in undecided positions",
        "detail": f"Moves {peak} vs moves 1-10: {100 * d:+.1f} per 100 moves (95% interval {100 * lo:+.1f} to {100 * hi:+.1f}, resampling whole games).",
        "status": "shown" if ok and lo > 0 else "checked", "tip": TIPS["danger"]})

    # 2. missed gifts
    n = punished = partly = gave = 0
    games_with = 0
    for g in games:
        gift_plies = {t["i"] + 1 for t in g["theirs"] if t["drop"] >= GIFT_DROP and t["wb_me"] < WON}
        games_with += bool(gift_plies)
        for m in g["mine"]:
            if m["i"] in gift_plies:
                n += 1
                if m["drop"] < 5:
                    punished += 1
                elif m["drop"] < MISSED_DROP:
                    partly += 1
                else:
                    gave += 1
    lines.append({
        "id": "gifts", "title": "Missed gifts",
        "stat": f"Opponents blundered (one move losing at least 15 Win%) {n:,} times in {games_with:,} games when you weren't already winning. "
                f"Your next move kept the advantage {punished:,} times ({_f(100 * punished / n)}%: lost under 5 Win%), "
                f"gave back part of it {partly:,} times ({_f(100 * partly / n)}%: 5-10 Win%) and gave back at least 10 Win% "
                f"{gave:,} times ({_f(100 * gave / n)}%)." if n else "No opponent blunders yet.",
        "sample": f"{n:,} opponent blunders",
        "detail": "Opponents' moves are judged by pass 1 only (200k nodes); their moves never get a deep check, so single cases can be pass-1 noise.",
        "status": "shown" if n >= MIN_EVENTS else "checked", "tip": TIPS["gifts"]})

    # 3. thrown wins
    th = thrown(games)
    win_n, thr_n = sum(th["winning"].values()), sum(th["thrown"].values())
    fell = sum(v for k, v in th["stage"].items() if k != "never fell below 50")
    lines.append({
        "id": "thrown", "title": "Thrown wins",
        "stat": f"You reached a winning position (Win% at least 90, about +6 pawns) in {win_n:,} games and didn't win {thr_n:,} "
                f"({_f(100 * thr_n / max(1, win_n), 0)}%): " + ", ".join(
                    f"{tc} {th['thrown'][tc]}/{th['winning'][tc]}" for tc in ("bullet", "blitz", "rapid")) +
                f". {th['how']['lost on time']} lost on time while still winning, {th['how']['blundered, then lost on time']} "
                f"blundered below 50% and then lost on time, {th['how']['lost on the board']} lost on the board, "
                f"{th['how']['drawn']} drawn. Of the {fell} that fell below 50%, {th['stage']['1-20']} did so by move 20.",
        "sample": f"{win_n:,} games",
        "status": "shown" if win_n >= MIN_GAMES and thr_n >= MIN_EVENTS else "checked", "tip": TIPS["thrown"]})

    # 4. blunders where several moves were fine
    om = one_move_errors(mistakes)
    sev, clear = om["several fine moves"], om["one clear best move"]
    tot = sev["total"] + clear["total"]
    lines.append({
        "id": "several", "title": "Blunders where several moves were fine",
        "stat": f"{sev['total']:,} of your {tot:,} deep-checked blunders ({_f(100 * sev['total'] / max(1, tot), 0)}%) came in positions "
                f"where at least two moves were fine (second-best within 15 Win% of the best, so they never became cards). "
                f"In those, the engine's reply line won 3+ points of material {sev['loses material']:,} times "
                f"({_f(100 * sev['loses material'] / max(1, sev['total']), 0)}%), {sev['hung piece']:,} left a piece to be taken, "
                f"and {sev['allowed mate']:,} allowed a forced mate.",
        "sample": f"{sev['total']:,} blunders",
        "status": "shown" if sev["total"] >= MIN_EVENTS else "checked", "tip": TIPS["several"]})

    # 5. time controls
    tcs = ("bullet", "blitz", "rapid")
    per_tc = {tc: _per_game(games, tc=tc, event=lambda m: True) for tc in tcs}
    cnt = {}
    for tc in tcs:
        c = Counter()
        for g in games:
            if g["tc"] != tc:
                continue
            for m in g["mine"]:
                if _undecided(m):
                    c["moves"] += 1
                    lab = label_of(m["drop"])
                    if lab:
                        c[lab] += 1
        cnt[tc] = c
    d, lo, hi = boot_diff(_per_game(games, tc="rapid"), _per_game(games, tc="bullet"))
    ok = all(cnt[tc]["moves"] >= MIN_MOVES for tc in tcs)
    sentence = " Rapid is not cleaner than bullet." if lo > 0 else ""
    lines.append({
        "id": "tc", "title": "Time controls side by side",
        "stat": "Per 100 moves in positions still in the balance: " + "; ".join(
            f"{tc}: inaccuracies {_f(100 * cnt[tc]['inaccuracy'] / cnt[tc]['moves'])}, mistakes {_f(100 * cnt[tc]['mistake'] / cnt[tc]['moves'])}, "
            f"blunders {_f(100 * cnt[tc]['blunder'] / cnt[tc]['moves'])}" for tc in tcs if cnt[tc]["moves"]) + "." + sentence,
        "sample": ", ".join(f"{tc} {cnt[tc]['moves']:,} moves" for tc in tcs),
        "detail": f"Rapid minus bullet blunders: {100 * d:+.1f} per 100 moves (95% interval {100 * lo:+.1f} to {100 * hi:+.1f}, resampling whole games).",
        "status": "shown" if ok else "checked", "tip": TIPS["tc"] if sentence else None})
    del per_tc

    # ---- checked: tilt, game number, time of day (rating-adjusted)
    by_session = defaultdict(list)
    for g in games:
        by_session[g["session"]].append(g)
    a2, oth = [], []
    for ss in by_session.values():
        for j in range(2, len(ss)):
            (a2 if ss[j - 1]["result"] == ss[j - 2]["result"] == "loss" else oth).append(ss[j])
    la, lo_ = sum(g["result"] == "loss" for g in a2), sum(g["result"] == "loss" for g in oth)
    tilt_ok = len(a2) >= MIN_GAMES and len(oth) >= MIN_GAMES
    if tilt_ok:
        d, lo, hi = diff_ci(la, len(a2), lo_, len(oth))
        clear_ = lo > 0
        lines.append({
            "id": "tilt", "title": "Tilt: after two losses in a row",
            "stat": f"After two straight losses in a session you lost {_f(100 * la / len(a2))}% of the next games ({la}/{len(a2)}), "
                    f"against {_f(100 * lo_ / len(oth))}% otherwise ({lo_}/{len(oth)}): {100 * d:+.1f} points, 95% interval {100 * lo:+.1f} to {100 * hi:+.1f}.",
            "sample": f"{len(a2) + len(oth):,} games with two earlier games in the session",
            "detail": "A session: games where each starts no more than "
                      f"{SESSION_GAP_MIN} minutes after the previous one ended.",
            "status": "shown" if clear_ else "checked", "tip": TIPS["tilt"] if clear_ else None})
    for lid, title, key, order in (
            ("gameno", "Results by game number in a session", lambda g: k_bucket(g["k"]), ["1", "2", "3", "4-5", "6-10", "11+"]),
            ("hour", "Results by time of day", lambda g: hour_bucket(g, tz), ["00-06", "06-12", "12-18", "18-24"])):
        parts, clear_ = [], False
        for b in order:
            gs = [g for g in games if key(g) == b]
            nn, m, lo, hi = _resid_ci(gs)
            if nn < MIN_GAMES:
                parts.append(f"{b}: {nn} games (too few)")
                continue
            parts.append(f"{b}: {m:+.1f} ({lo:+.1f} to {hi:+.1f}, {nn} games)")
            clear_ |= lo > 0 or hi < 0
        lines.append({"id": lid, "title": title,
                      "stat": "Score minus rating-expected score, in points: " + "; ".join(parts) + ".",
                      "sample": f"{len(games):,} games",
                      "detail": "Expected score from the Elo formula on the two ratings stored with each game; 95% intervals.",
                      "status": "shown" if clear_ else "checked", "tip": TIPS[lid] if clear_ else None})

    return {"format": 1, "games": len(games), "lines": lines,
            "thresholds": {"games": MIN_GAMES, "moves": MIN_MOVES, "events": MIN_EVENTS,
                           "comparisons": "the 95% interval of the difference excludes zero"}}
