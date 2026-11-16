"""Rating lines for the Progress section (added 2026-11-16).

One line per site and format (bullet, blitz, rapid), rated games only:
  - my rating at the training start date and now,
  - my performance rating in games since the start, with a 95% interval from
    resampling whole games, and the games behind it.

What the stored ratings mean (checked on the stored games: the rating change
between two games matches the result of the later game for Chess.com in 834 of
841 cases, and of the earlier game for Lichess in 125 of 126):
  - Chess.com stores each player's rating AFTER the game;
  - Lichess stores it BEFORE the game (the change isn't stored).
So "at the start" is the rating after the last game before the start date
(Chess.com) or before the first game since it (Lichess), and "now" is the rating
after (Chess.com) or before (Lichess) the latest game.

Performance rating: the rating R at which the Elo formula's expected score
against the actual opponents, sum 1/(1+10^((opp-R)/400)), equals my score.
A score of 0 or 100% has no finite answer, so the score is kept half a point
inside (0.5 to N-0.5). Opponent ratings are as stored: for Chess.com that is
after the game, a few points off their rating before it.
"""
from __future__ import annotations

import random
from datetime import datetime
from zoneinfo import ZoneInfo

SITES = ("chesscom", "lichess")
TCS = ("bullet", "blitz", "rapid")
BOOT = 1000
SEED = 20261116


def performance(opps: list[float], score: float) -> float:
    n = len(opps)
    s = min(max(score, 0.5), n - 0.5)
    lo, hi = min(opps) - 1200.0, max(opps) + 1200.0
    for _ in range(30):  # bisection: expected score rises with R
        mid = (lo + hi) / 2
        if sum(1 / (1 + 10 ** ((o - mid) / 400)) for o in opps) < s:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def rating_lines(games: list[dict], settings: dict) -> dict:
    tz = ZoneInfo(settings["insights"]["timezone"])
    start = settings["progress"]["training_start"]
    min_games = settings["progress"]["min_games_rating"]
    sc = {"win": 1.0, "draw": 0.5, "loss": 0.0}

    def local_day(g):
        return datetime.fromisoformat(g["ended_at"].replace("Z", "+00:00")).astimezone(tz).date().isoformat()

    rows = []
    for site in SITES:
        for tc in TCS:
            gs = sorted((g for g in games if g["site"] == site and g["time_class"] == tc and g.get("rated")
                         and g[g["my_color"]].get("rating")), key=lambda g: g["ended_at"])
            if not gs:
                continue
            opp = lambda g: g["black" if g["my_color"] == "white" else "white"].get("rating")  # noqa: E731
            mine = lambda g: g[g["my_color"]]["rating"]  # noqa: E731
            before = [g for g in gs if local_day(g) < start]
            since = [g for g in gs if local_day(g) >= start]
            if site == "chesscom":
                at_start = mine(before[-1]) if before else None
                now = mine(gs[-1])
            else:
                at_start = mine(since[0]) if since else (mine(before[-1]) if before else None)
                now = mine(gs[-1])
            row = {"site": site, "tc": tc, "start": at_start, "now": now, "now_date": local_day(gs[-1]),
                   "games": len(since), "w": sum(g["my_result"] == "win" for g in since),
                   "d": sum(g["my_result"] == "draw" for g in since), "l": sum(g["my_result"] == "loss" for g in since),
                   "enough": len(since) >= min_games}
            pts = [(opp(g), sc[g["my_result"]]) for g in since if opp(g)]
            if pts:
                row["opp_avg"] = round(sum(o for o, _ in pts) / len(pts))
            if row["enough"] and pts:
                perf = performance([o for o, _ in pts], sum(s for _, s in pts))
                rng = random.Random(SEED)
                bs = sorted(performance([o for o, _ in x], sum(s for _, s in x))
                            for x in (rng.choices(pts, k=len(pts)) for _ in range(BOOT)))
                row.update(perf=round(perf), lo=round(bs[int(0.025 * BOOT)]), hi=round(bs[int(0.975 * BOOT) - 1]))
            rows.append(row)
    return {"rows": rows, "min_games": min_games, "start": start}
