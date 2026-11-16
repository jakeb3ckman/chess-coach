"""2026-11-16 additions: clock diagnostics (coach/clock.py) and rating lines
(coach/ratings.py). Bare numbers only, no positions (spec 8.5)."""
import math

from coach.clock import band_of, clock_lines, game_kind, increment, long_thinks, pace_by_stage, rushing
from coach.ratings import performance, rating_lines


def _m(n, wa, spent=2.0, clk=100.0, wb=None, drop=0.0):
    return {"i": 2 * (n - 1), "n": n, "drop": drop, "src": 1, "clk": clk, "spent": spent,
            "wb": wa if wb is None else wb, "wa": wa}


def _g(tc, result, term, mine, base=60, inc=0):
    return {"tc": tc, "base": base, "inc": inc, "result": result, "termination": term, "mine": mine}


def test_game_kinds_follow_the_thrown_wins_definitions():
    up = [_m(1, 50), _m(2, 95), _m(3, 70)]
    assert game_kind(_g("bullet", "win", "won by resignation", up)) == "won"
    assert game_kind(_g("bullet", "loss", "opp won on time", up)) == "lot"
    fell = up + [_m(4, 30)]
    assert game_kind(_g("bullet", "loss", "opp won on time", fell)) is None  # fell below 50 first
    assert game_kind(_g("bullet", "loss", "opp won on time", [_m(1, 50), _m(2, 80)])) is None  # never winning
    assert band_of(0.55) == ">50%" and band_of(0.5) == ">50%" and band_of(0.05) == "<10%" and band_of(0.1) == "10-20%"


def test_pace_by_stage_is_share_of_starting_clock_and_needs_samples():
    lot = [_g("bullet", "loss", "x won on time", [_m(1, 95, spent=3.0)] + [_m(n, 95, spent=3.0) for n in range(2, 11)])
           for _ in range(60)]
    won = [_g("bullet", "win", "x", [_m(n, 95, spent=1.2) for n in range(1, 11)]) for _ in range(60)]
    gs = lot + won
    for g in gs:
        g["kind"] = game_kind(g)
    out = pace_by_stage(gs)
    row = out["tables"][0]["rows"][0]
    assert row[0] == "1–10" and row[1].startswith("5.00%") and row[2].startswith("2.00%")  # 3 s and 1.2 s of 60 s
    assert out["clear"] == [("bullet", "1-10", out["clear"][0][2])] and out["clear"][0][2] > 0
    # Under 50 games lost on time while winning: no comparison.
    few = lot[:40] + won
    assert pace_by_stage(few)["tables"][0]["rows"][0][3] == "too few games"


def test_long_thinks_threshold_is_ten_percent_of_the_base():
    g = _g("blitz", "win", "x", [_m(1, 50, spent=29.9), _m(2, 50, spent=30.0), _m(25, 50, spent=31.0)], base=300)
    g["kind"] = None
    t = long_thinks([g])["tables"][0]
    assert t["rows"][0][2] == "1" and t["rows"][1][0] == "21–30" and t["rows"][1][2] == "1"
    assert "2 long thinks in 3 moves" in t["title"]


def test_increment_compares_only_formats_with_the_same_base():
    def w(base, inc, lost):
        g = _g("blitz", "loss" if lost else "win", "x won on time" if lost else "x", [_m(1, 95)], base=base, inc=inc)
        g["reached"], g["lost_time"] = True, lost
        return g
    gs = [w(300, 0, i % 4 == 0) for i in range(80)] + [w(300, 5, i % 10 == 0) for i in range(60)] + [w(120, 1, True)] * 9
    d = increment(gs)
    assert len(d["pairs"]) == 1 and d["pairs"][0].startswith("base 5 min: with increment 6/60, without 20/80")
    assert [r[0] for r in d["rows"]] == ["Blitz 2+1", "Blitz 5+0", "Blitz 5+5"]


def test_rushing_counts_winning_positions_only():
    g = _g("rapid", "win", "x", [_m(30, 95, clk=30, drop=20), _m(31, 95, clk=400, drop=0), _m(32, 60, clk=30, drop=40)],
           base=600)
    r = rushing([g])
    assert r["rows"] == [["Rapid", "100.0 (1 in 1)", "0.0 (0 in 1)", "too few moves"]]  # the Win% 60 move isn't counted


def test_clock_lines_have_the_insight_fields():
    gs = [_g("bullet", "win", "x", [_m(n, 95) for n in range(1, 30)])]
    for line in clock_lines(gs):
        assert {"id", "title", "stat", "sample", "status", "tip"} <= set(line) and line["status"] in ("shown", "checked")
        assert line["status"] == "checked" or line["id"] == "long_thinks"  # far too few games for any comparison


def test_performance_rating_matches_the_elo_formula():
    assert abs(performance([1000] * 10, 5) - 1000) < 0.01
    r = performance([1000] * 4, 3)  # 75% against 1000
    assert abs(r - (1000 + 400 * math.log10(3))) < 0.01
    assert performance([1000] * 4, 4) == performance([1000] * 4, 3.5)  # 100% is kept half a point inside


def _rg(site, tc, day, mine, opp, result):
    return {"site": site, "time_class": tc, "rated": True, "ended_at": f"{day}T17:00:00Z", "my_color": "white",
            "white": {"rating": mine}, "black": {"rating": opp}, "my_result": result}


def test_rating_lines_start_now_and_threshold(settings):
    settings["progress"]["training_start"] = "2026-11-14"
    settings["progress"]["min_games_rating"] = 3
    gs = [_rg("chesscom", "blitz", "2026-11-10", 400, 400, "win"), _rg("chesscom", "blitz", "2026-11-14", 408, 410, "win"),
          _rg("chesscom", "blitz", "2026-11-15", 400, 420, "loss"), _rg("chesscom", "blitz", "2026-11-16", 409, 390, "win"),
          _rg("lichess", "rapid", "2026-11-12", 900, 900, "win"), _rg("lichess", "rapid", "2026-11-15", 910, 905, "loss")]
    rows = {(r["site"], r["tc"]): r for r in rating_lines(gs, settings)["rows"]}
    cb = rows[("chesscom", "blitz")]
    assert (cb["start"], cb["now"], cb["games"], cb["w"], cb["l"]) == (400, 409, 3, 2, 1)  # Chess.com: rating after the game
    assert cb["enough"] and cb["lo"] <= cb["perf"] <= cb["hi"]
    lr = rows[("lichess", "rapid")]
    assert (lr["start"], lr["now"], lr["games"], lr["enough"]) == (910, 910, 1, False)  # Lichess: rating before the game
    assert "perf" not in lr
