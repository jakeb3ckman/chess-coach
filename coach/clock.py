"""Clock diagnostics for the Insights screen (added 2026-11-16).

Every number comes from the clock stored after each move in the game files and
the pass-1/pass-2 scores in the analysis files, through insights.load_games:
  m["spent"]  seconds my move took (clock before - clock after + increment)
  m["clk"]    my clock before the move, seconds
  m["wb"]     my Win% before the move (pass 1)
  m["drop"]   Win% my move lost (deep pass where stored, as everywhere else)
Time is expressed as a share of the starting clock (base time), so 1+0, 3+0
and 10+0 games can be put side by side.

Definitions (shared with the 'Thrown wins' line):
  winning game         I reached Win% >= 90 after one of my moves
  lost on time while winning   a winning game I lost on time without first
                               falling below 50 Win%
  converted            a winning game I won
  long think           one move that used at least LONG_FRAC of the starting clock
  low clock / plenty   clock before the move under 10% / at least 50% of the start
Same standards as the other lines: counts shown, sample thresholds, 95%
intervals from resampling whole games, tips kept separate.
"""
from __future__ import annotations

import random
from collections import Counter

from . import insights as I

TCS = ("bullet", "blitz", "rapid")
STAGES = [("1-10", 1, 10), ("11-20", 11, 20), ("21-30", 21, 30), ("31-40", 31, 40), ("41+", 41, 10_000)]
CLOCK_BANDS = [(">50%", .5, 99.0), ("20-50%", .2, .5), ("10-20%", .1, .2), ("<10%", 0.0, .1)]
LONG_FRAC = 0.10      # a long think: one move using at least 10% of the starting clock
LOW_FRAC = 0.10       # low on clock: under 10% of the starting clock left before the move
PLENTY_FRAC = 0.50    # plenty: at least half the starting clock left
WIN = I.WON           # 90 Win%

TIPS = {
    "pace": "Give yourself a clock budget for the opening: play the moves you know quickly and keep long thinks for positions that need them.",
    "pace_winning_slow": "When you're clearly winning you don't need the best move, only a safe one. Keep a steady pace and simplify.",
    "pace_winning_fast": "Moving faster when you're winning saves clock. Keep it safe: before each move, look at your opponent's checks and captures.",
    "long_thinks": "Before a long think, look at the clock. If one move would cost a tenth of your time, choose a safe move and move on.",
    "increment": "If you often lose won games on time, try formats with increment: every move then gives a little time back.",
    "rushing": "When you're winning and short of time, play safe moves: check that your move leaves nothing hanging, then move.",
}


def _and(xs: list[str]) -> str:
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]


def stage_of(n: int) -> str:
    return next(s for s, lo, hi in STAGES if lo <= n <= hi)


def band_of(frac: float) -> str:
    return next(b for b, lo, hi in CLOCK_BANDS if lo <= frac < hi)


def game_kind(g: dict) -> str | None:
    """'lot' = lost on time while winning, 'won' = converted, else None."""
    peak, fell = False, False
    for m in g["mine"]:
        if m["wa"] >= WIN:
            peak = True
        elif peak and m["wa"] < I.LOST_BELOW:
            fell = True
            break
    if not peak:
        return None
    if g["result"] == "win":
        return "won"
    if g["result"] == "loss" and "time" in g["termination"].lower() and not fell:
        return "lot"
    return None


def lost_on_time(g: dict) -> bool:
    return g["result"] == "loss" and "time" in g["termination"].lower()


def reached_win(g: dict) -> bool:
    return any(m["wa"] >= WIN for m in g["mine"])


def boot(units: list, stat, seed: int = I.BOOT_SEED) -> tuple[float, float, float]:
    """stat(units) with a 95% interval from resampling the units (whole games)."""
    rng = random.Random(seed)
    s0 = stat(units)
    xs = sorted(stat(rng.choices(units, k=len(units))) for _ in range(I.BOOT))
    return s0, xs[int(0.025 * I.BOOT)], xs[int(0.975 * I.BOOT) - 1]


def _pct(x: float, nd: int = 1) -> str:
    return f"{100 * x:.{nd}f}%"


def _sgn(x: float, nd: int = 1) -> str:
    return f"{x:+.{nd}f}".replace("-", "−")


def _ci(d: float, lo: float, hi: float, scale: float = 100, nd: int = 1) -> str:
    return f"{_sgn(scale * d, nd)} ({_sgn(scale * lo, nd)} to {_sgn(scale * hi, nd)})"


def _fmt(tc_games: list[dict]) -> tuple[int, int, str]:
    """The most common format of these games: (base, increment, '3+0')."""
    (base, inc), _ = Counter((g["base"], g["inc"]) for g in tc_games).most_common(1)[0]
    return base, inc, f"{base / 60:g}+{inc}"


def _secs(tc_games: list[dict]) -> str:
    """'1% = 0.6 s in 1+0' for the most common format, to make shares concrete."""
    if not tc_games:
        return ""
    base, _, name = _fmt(tc_games)
    return f"1% = {base / 100:.1f} s in {name}"


# ---------------------------------------------------------------- a. pace by stage

def pace_by_stage(games: list[dict]) -> dict:
    out = {"tables": [], "clear": [], "lot_games": {}, "won_games": {}, "by20": {}, "base": {}, "fmt": {}}
    for tc in TCS:
        gs = [g for g in games if g["tc"] == tc and g["kind"] in ("lot", "won")]
        lot = [g for g in gs if g["kind"] == "lot"]
        won = [g for g in gs if g["kind"] == "won"]
        out["lot_games"][tc], out["won_games"][tc] = len(lot), len(won)
        rows = []
        for s, lo, hi in STAGES:
            def per(group):
                r = []
                for g in group:
                    ms = [m for m in g["mine"] if lo <= m["n"] <= hi and m["spent"] is not None]
                    if ms:
                        r.append((sum(m["spent"] / g["base"] for m in ms), len(ms)))
                return r
            a, b = per(lot), per(won)
            na, nb = sum(x[1] for x in a), sum(x[1] for x in b)
            if not na or not nb:
                continue
            ra, rb = sum(x[0] for x in a) / na, sum(x[0] for x in b) / nb
            enough = len(lot) >= I.MIN_GAMES and na >= I.MIN_MOVES and nb >= I.MIN_MOVES
            if enough:
                d, l, h = I.boot_diff(a, b)
                diff = _ci(d, l, h, nd=2)
                if round(100 * l, 2) > 0 or round(100 * h, 2) < 0:  # clear as displayed (2 decimals)
                    out["clear"].append((tc, s, d))
            else:
                diff = "too few moves" if len(lot) >= I.MIN_GAMES else "too few games"
            rows.append([s.replace("-", "–"), f"{_pct(ra, 2)} ({na:,})", f"{_pct(rb, 2)} ({nb:,})", diff])
            if hi <= 20 and enough:
                out["by20"][tc] = out["by20"].get(tc, 0.0) + (ra - rb) * 10
        if gs:
            out["base"][tc], _, out["fmt"][tc] = _fmt(gs)
        if rows:
            out["tables"].append({
                "title": f"{tc.capitalize()}: {len(lot)} lost on time while winning, {len(won)} converted · {_secs(gs)}",
                "head": ["Moves", "Lost on time", "Converted", "Difference, points (95%)"], "rows": rows})
    return out


# ---------------------------------------------------------------- b. pace when winning

def _band_means(gs: list[dict]) -> dict:
    """band -> [winning secs share, winning moves, balanced share, balanced moves]."""
    acc: dict[str, list] = {}
    for g in gs:
        for b, v in g["bands"].items():
            a = acc.setdefault(b, [0.0, 0, 0.0, 0])
            for k in range(4):
                a[k] += v[k]
    return acc


def _matched_diff(gs: list[dict]) -> float:
    """Winning minus balanced time per move, compared inside each clock band and
    weighted by the winning moves in that band (so less clock late in the game
    doesn't count as playing faster when winning)."""
    acc = _band_means(gs)
    tot = sum(a[1] for a in acc.values() if a[1] and a[3])
    if not tot:
        return 0.0
    return sum(a[1] / tot * (a[0] / a[1] - a[2] / a[3]) for a in acc.values() if a[1] and a[3])


def pace_when_winning(games: list[dict]) -> dict:
    rows, clear, ok_any = [], [], False
    for tc in TCS:
        gs = []
        for g in games:
            if g["tc"] != tc:
                continue
            bands: dict[str, list] = {}
            for m in g["mine"]:
                if m["spent"] is None or m["clk"] is None or m["n"] <= I.OPENING_MOVES or m["wb"] < I.UNDECIDED[0]:
                    continue
                v = bands.setdefault(band_of(m["clk"] / g["base"]), [0.0, 0, 0.0, 0])
                k = 0 if m["wb"] >= WIN else 2
                v[k] += m["spent"] / g["base"]
                v[k + 1] += 1
            if bands:
                gs.append({"bands": bands})
        acc = _band_means(gs)
        wn, bn = sum(a[1] for a in acc.values()), sum(a[3] for a in acc.values())
        if not wn or not bn:
            continue
        raw_w, raw_b = sum(a[0] for a in acc.values()) / wn, sum(a[2] for a in acc.values()) / bn
        if wn >= I.MIN_MOVES and bn >= I.MIN_MOVES:
            ok_any = True
            d, lo, hi = boot(gs, _matched_diff)
            diff = _ci(d, lo, hi, nd=2)
            if lo > 0 or hi < 0:
                clear.append((tc, d))
        else:
            diff = "too few moves"
        rows.append([tc.capitalize(), f"{_pct(raw_w, 2)} ({wn:,})", f"{_pct(raw_b, 2)} ({bn:,})", diff])
    total = sum(int(r[1].split("(")[1].rstrip(")").replace(",", "")) + int(r[2].split("(")[1].rstrip(")").replace(",", "")) for r in rows)
    return {"rows": rows, "clear": clear, "ok": ok_any, "moves": total}


# ---------------------------------------------------------------- c. long thinks

def long_thinks(games: list[dict]) -> dict:
    tables, comps, total_moves = [], [], 0
    for tc in TCS:
        gs = [g for g in games if g["tc"] == tc]
        if not gs:
            continue
        n, c = Counter(), Counter()
        with_one = 0
        per = {"lot": [], "won": []}
        for g in gs:
            k = 0
            mv = 0
            for m in g["mine"]:
                if m["spent"] is None:
                    continue
                s = stage_of(m["n"])
                n[s] += 1
                mv += 1
                if m["spent"] >= LONG_FRAC * g["base"]:
                    c[s] += 1
                    k += 1
            with_one += k > 0
            if g["kind"] in per and mv:
                per[g["kind"]].append((k, mv))
        tot_n, tot_c = sum(n.values()), sum(c.values())
        total_moves += tot_n
        rows = [[s.replace("-", "–"), f"{100 * c[s] / n[s]:.1f}" if n[s] else "–", f"{c[s]:,}",
                 f"{_pct(c[s] / tot_c, 0) if tot_c else '–'}"] for s, _, _ in STAGES if n[s]]
        base, _, name = _fmt(gs)
        tables.append({"title": f"{tc.capitalize()}: {tot_c:,} long thinks in {tot_n:,} moves; "
                                f"{with_one:,} of {len(gs):,} games ({_pct(with_one / len(gs), 0)}) had at least one "
                                f"({LONG_FRAC:.0%} = {base * LONG_FRAC:g} s in {name})",
                       "head": ["Moves", "Per 100 moves", "Long thinks", "Share of all"], "rows": rows})
        a, b = per["lot"], per["won"]
        if len(a) >= I.MIN_GAMES and sum(x[1] for x in a) >= I.MIN_MOVES and sum(x[1] for x in b) >= I.MIN_MOVES:
            d, lo, hi = I.boot_diff(a, b)
            ra = sum(x[0] for x in a) / sum(x[1] for x in a)
            rb = sum(x[0] for x in b) / sum(x[1] for x in b)
            comps.append(f"{tc}: {100 * ra:.1f} per 100 moves in games lost on time while winning ({len(a)} games) vs "
                         f"{100 * rb:.1f} in games converted ({len(b)}), difference {_ci(d, lo, hi)}")
        else:
            comps.append(f"{tc}: too few games lost on time while winning ({len(a)})")
    return {"tables": tables, "comps": comps, "moves": total_moves}


# ---------------------------------------------------------------- d. increment

def increment(games: list[dict]) -> dict:
    """Among winning games: share lost on time, by format, and with against without
    increment at the same base time (the only fair pairing)."""
    fmts: dict[tuple, list[int]] = {}
    for g in games:
        if not g["reached"]:
            continue
        f = fmts.setdefault((g["tc"], g["base"], g["inc"]), [0, 0])
        f[0] += g["lost_time"]
        f[1] += 1
    rows = [[f"{tc.capitalize()} {b / 60:g}+{inc}", f"{x:,} of {n:,}", _pct(x / n, 0)]
            for (tc, b, inc), (x, n) in sorted(fmts.items(), key=lambda kv: (TCS.index(kv[0][0]), kv[0][1], kv[0][2]))
            if n >= 5]
    pairs, clear = [], []
    for base in sorted({b for _, b, _ in fmts}):
        w = [v for (tc, b, inc), v in fmts.items() if b == base and inc > 0]
        wo = [v for (tc, b, inc), v in fmts.items() if b == base and inc == 0]
        xw, nw = sum(v[0] for v in w), sum(v[1] for v in w)
        xo, no = sum(v[0] for v in wo), sum(v[1] for v in wo)
        if not nw or not no:
            continue
        label = f"base {base / 60:g} min: with increment {xw}/{nw}, without {xo}/{no}"
        if nw >= I.MIN_GAMES and no >= I.MIN_GAMES:
            d, lo, hi = I.diff_ci(xw, nw, xo, no)
            pairs.append(f"{label}, difference {_ci(d, lo, hi)}")
            if lo > 0 or hi < 0:
                clear.append((base, d))
        else:
            pairs.append(f"{label} (too few games with {'increment' if nw < I.MIN_GAMES else 'no increment'})")
    return {"rows": rows, "pairs": pairs, "clear": clear}


# ---------------------------------------------------------------- e. rushing when winning

def rushing(games: list[dict], min_n: int = 1) -> dict:
    """Blunder rate (my move loses >= 15 Win%) in clearly winning positions
    (Win% before >= 90), low clock against plenty. min_n: only moves from this
    move number on (to check whether move number explains the difference)."""
    rows, res, moves = [], {}, 0
    for tc in TCS:
        low, plenty = [], []
        for g in games:
            if g["tc"] != tc:
                continue
            a, b = [0, 0], [0, 0]
            for m in g["mine"]:
                if m["clk"] is None or m["wb"] < WIN or m["n"] < min_n:
                    continue
                f = m["clk"] / g["base"]
                t = a if f < LOW_FRAC else b if f >= PLENTY_FRAC else None
                if t is not None:
                    t[0] += m["drop"] >= 15
                    t[1] += 1
            if a[1]:
                low.append(tuple(a))
            if b[1]:
                plenty.append(tuple(b))
        nl, npl = sum(x[1] for x in low), sum(x[1] for x in plenty)
        moves += nl + npl
        bl, bp = sum(x[0] for x in low), sum(x[0] for x in plenty)
        if nl >= I.MIN_MOVES and npl >= I.MIN_MOVES:
            d, lo, hi = I.boot_diff(low, plenty)
            res[tc] = (d, lo, hi)
            diff = _ci(d, lo, hi)
        else:
            diff = "too few moves"
        if nl or npl:
            rows.append([tc.capitalize(), f"{100 * bl / nl:.1f} ({bl:,} in {nl:,})" if nl else "–",
                         f"{100 * bp / npl:.1f} ({bp:,} in {npl:,})" if npl else "–", diff])
    return {"rows": rows, "res": res, "moves": moves}


def _rush_reason(e: dict, late: dict) -> str:
    raw = [(tc, d) for tc, (d, lo, hi) in e["res"].items() if lo > 0 or hi < 0]
    out = []
    if raw:
        out.append("All moves counted: " + "; ".join(f"{'more' if d > 0 else 'fewer'} blunders with low clock in {tc}" for tc, d in raw) + ".")
    few = [tc for tc in TCS if tc not in late["res"]]
    unclear = [tc for tc, (d, lo, hi) in late["res"].items() if lo <= 0 <= hi]
    why = []
    if few:
        why.append(f"from move 21 there are too few moves with plenty of clock in {_and(few)}")
    if unclear:
        why.append(f"from move 21 {_and(unclear)} shows no clear difference")
    out.append("Not shown as a pattern: " + "; ".join(why) + ", so move number (low clock comes late, in simpler positions) "
               "may explain it." if why else "No clear difference.")
    return " ".join(out)


# ---------------------------------------------------------------- the lines

def clock_lines(games: list[dict]) -> list[dict]:
    for g in games:
        g["kind"] = game_kind(g)
        g["reached"] = reached_win(g)
        g["lost_time"] = lost_on_time(g)
    lines = []
    note = "Time per move = clock before the move minus clock after it plus the increment, as a share of the starting clock."

    # a. pace by stage
    a = pace_by_stage(games)
    lot_n = sum(a["lot_games"].values())
    shown = bool(a["clear"]) and any(v >= I.MIN_GAMES for v in a["lot_games"].values())
    def cells(sign):
        by = {}
        for tc, st, d in a["clear"]:
            if (d > 0) == sign:
                by.setdefault(tc, []).append(st.replace("-", "–"))
        return "; ".join(f"{tc} moves {_and(v)}" for tc, v in by.items())
    more, less = cells(True), cells(False)
    clear_txt = "; ".join(x for x in (f"more time per move in games lost on time in {more}" if more else "",
                                      f"less in {less}" if less else "") if x)
    extra = [f"{tc} {100 * v:.0f}% of the starting clock ({v * a['base'][tc]:.0f} s in {a['fmt'][tc]})"
             for tc, v in a["by20"].items() if v > 0 and any(t == tc for t, _, _ in a["clear"])]
    if extra:
        clear_txt += ". By move 20, games lost on time had used about this much more clock: " + _and(extra)
    lines.append({
        "id": "pace", "title": "Clock: pace by stage, games lost on time while winning vs converted",
        "stat": "Average time per move as a share of the starting clock (number of moves in brackets). "
                + (f"Clear differences: {clear_txt}." if a["clear"] else "No stage shows a clear difference."),
        "tables": a["tables"],
        "sample": f"{lot_n:,} games lost on time while winning and {sum(a['won_games'].values()):,} converted",
        "detail": "Winning game: Win% at least 90 after one of your moves. Lost on time while winning: lost on time without first "
                  "falling below 50 Win%. " + note + f" A stage needs {I.MIN_MOVES} moves on each side and {I.MIN_GAMES} games lost on time. "
                  "This compares the two kinds of game; it shows where the clock went, not what caused the loss. With 10+ stage "
                  "comparisons, one may exclude zero by chance.",
        "status": "shown" if shown else "checked", "tip": TIPS["pace"] if shown else None})

    # b. pace when winning
    b = pace_when_winning(games)
    slower = [tc for tc, d in b["clear"] if d > 0]
    faster = [tc for tc, d in b["clear"] if d < 0]
    shown = bool(b["clear"])
    if shown:
        parts = ([f"slower when winning in {_and(slower)}"] if slower else []) + ([f"faster when winning in {_and(faster)}"] if faster else [])
        verdict = f"With the clock left matched, you play {' and '.join(parts)}."
    else:
        verdict = "No clear difference once the clock left is matched."
    lines.append({
        "id": "pace_winning", "title": "Clock: pace when clearly winning",
        "stat": "Time per move as a share of the starting clock, from move 11: clearly winning positions (Win% at least 90) against "
                "positions still in the balance (Win% 10 to 90). " + verdict,
        "tables": [{"title": "Raw averages (moves in brackets) and the clock-matched difference in points",
                    "head": ["", "Winning", "Balanced", "Difference (95%)"], "rows": b["rows"]}],
        "sample": f"{b['moves']:,} of your moves from move 11 in winning or balanced positions",
        "detail": "Winning positions come later in the game, when less clock is left, so the raw averages aren't comparable. "
                  "The difference compares the two inside each clock band (over 50%, 20-50%, 10-20%, under 10% of the starting "
                  "clock left), weighted by the winning moves in each band; interval from resampling whole games. " + note,
        "status": "shown" if shown else "checked",
        "tip": (TIPS["pace_winning_slow"] if slower else TIPS["pace_winning_fast"]) if shown else None})

    # c. long thinks
    c = long_thinks(games)
    lines.append({
        "id": "long_thinks", "title": "Clock: long thinks",
        "stat": f"A long think = one move that used at least {LONG_FRAC:.0%} of the starting clock. Where they fall, per time control. "
                "Games lost on time while winning against games converted: " + "; ".join(c["comps"]) + ".",
        "tables": c["tables"],
        "sample": f"{c['moves']:,} moves",
        "detail": note + " Games lost on time used more clock by definition, so the comparison describes those games rather than "
                         "proving a cause.",
        "status": "shown" if c["moves"] >= I.MIN_MOVES else "checked", "tip": TIPS["long_thinks"]})

    # d. increment
    d = increment(games)
    lines.append({
        "id": "increment", "title": "Clock: increment and won games lost on time",
        "stat": "Games where you reached Win% 90 or more, and how many of them you lost on time, by format. "
                "With against without increment at the same base time: " + ("; ".join(d["pairs"]) or "no format pairs") + ".",
        "tables": [{"title": "Winning games lost on time, by format (5+ winning games)",
                    "head": ["Format", "Lost on time", "Share"], "rows": d["rows"]}],
        "sample": f"{sum(g['reached'] for g in games):,} winning games",
        "detail": "Formats with and without increment differ in base time too (for example 2+1 against 1+0), so only formats with "
                  f"the same base time are compared, and only with {I.MIN_GAMES}+ winning games on each side. "
                  + ("" if d["clear"] else "No such pair has enough games or a clear difference, so the effect of increment can't be separated from base time yet."),
        "status": "shown" if d["clear"] else "checked", "tip": TIPS["increment"] if d["clear"] else None})

    # e. rushing
    e = rushing(games)
    late = rushing(games, min_n=21)
    agree = [tc for tc, (dd, lo, hi) in e["res"].items()
             if (lo > 0 or hi < 0) and tc in late["res"] and (late["res"][tc][1] > 0 if dd > 0 else late["res"][tc][2] < 0)]
    lines.append({
        "id": "rushing", "title": "Clock: rushing in winning positions",
        "stat": f"Blunders per 100 moves in clearly winning positions (Win% at least 90 before your move), with under "
                f"{LOW_FRAC:.0%} of the starting clock left against {PLENTY_FRAC:.0%} or more. "
                + (f"Clear in {_and(agree)}, also when only moves from move 21 are counted." if agree else _rush_reason(e, late)),
        "tables": [{"title": "Blunders per 100 moves (blunders in moves)", "head": ["", "Low clock", "Plenty", "Difference (95%)"],
                    "rows": e["rows"]},
                   {"title": "Same, only moves from move 21 (low clock mostly comes late in the game)",
                    "head": ["", "Low clock", "Plenty", "Difference (95%)"], "rows": late["rows"]}],
        "sample": f"{e['moves']:,} of your moves in clearly winning positions",
        "detail": f"A blunder loses at least 15 Win% (deep pass where stored). Moves between {LOW_FRAC:.0%} and {PLENTY_FRAC:.0%} of the "
                  "clock are left out. Intervals from resampling whole games. A difference counts as clear only when it also holds "
                  "for moves from move 21, because low clock comes late in the game, where positions differ.",
        "status": "shown" if agree else "checked", "tip": TIPS["rushing"] if agree else None})
    return lines
