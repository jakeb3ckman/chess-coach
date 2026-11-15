"""Phase 3: opening names, the position pass, leak cards, insights.

Rule kept (spec 8.5): no fixture pairs a position with an evaluation or best move
written by hand. Tests that need engine output run the real Stockfish (tiny node
budgets) and check consistency with what it stored, not particular values.
"""
from datetime import datetime, timedelta, timezone

import chess

from coach.insights import assign_sessions, boot_diff, diff_ci, game_duration_s
from coach.openings import build_openings, family, move_scores, name_game, trend_blocks, variation
from coach.positions import collect_positions, load_position, pending_work, position_path, run_positions
from coach.store import Store

from .conftest import needs_engine


def uci(san_line: str) -> str:
    b = chess.Board()
    out = []
    for tok in san_line.split():
        if tok[0].isdigit():
            continue
        out.append(b.push_san(tok).uci())
    return " ".join(out)


# ---------------------------------------------------------------- names

def test_names_come_from_the_table_by_position():
    eco, name, ply = name_game(uci("1. e4 c6 2. d4 d5 3. e5").split())
    assert name == "Caro-Kann Defense: Advance Variation" and eco == "B12" and ply == 5
    assert family(name) == "Caro-Kann Defense" and variation(name) == "Caro-Kann Defense: Advance Variation"
    # Leaving the table keeps the last name reached.
    assert name_game(uci("1. e4 c6 2. d4 d5 3. e5 h5 4. a4 a5").split())[1] == name
    # A transposition gets the same name (matched by position, not move order).
    a = name_game(uci("1. d4 Nf6 2. c4 e6 3. Nc3 Bb4").split())
    b = name_game(uci("1. c4 Nf6 2. Nc3 e6 3. d4 Bb4").split())
    assert a == b and a[1] == "Nimzo-Indian Defense"


# ---------------------------------------------------------------- trends

def _g(i, result, me=1000, opp=1000):
    return {"my_color": "white", "white": {"rating": me}, "black": {"rating": opp}, "my_result": result,
            "ended_at": f"2026-01-01T00:00:{i:02d}Z" if i < 60 else f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}Z"}


def test_trend_blocks_size_merge_and_rating_adjustment():
    games = [_g(i, "win" if i % 2 else "loss") for i in range(70)]
    blocks = trend_blocks(games, 30)
    assert [b["games"] for b in blocks] == [30, 40]  # 10 left over (< half a block) join the last block
    assert all(b["expected"] == 50.0 and b["diff"] == round(b["score"] - 50.0, 1) for b in blocks)
    games = [_g(i, "win") for i in range(30)] + [_g(30 + i, "win") for i in range(15)]
    assert [b["games"] for b in trend_blocks(games, 30)] == [30, 15]  # 15 = half a block stays separate
    # Beating a weaker opponent counts for less than an even result suggests.
    weaker = [_g(i, "win", me=1400, opp=1000) for i in range(30)]
    assert trend_blocks(weaker, 30)[0]["expected"] > 90


# ---------------------------------------------------------------- sessions and intervals

def _gm(start_min, minutes, result="loss"):
    s = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=start_min)
    return {"start": s, "end": s + timedelta(minutes=minutes), "result": result}


def test_sessions_split_on_gaps_longer_than_15_minutes():
    gs = [_gm(0, 5), _gm(6, 5), _gm(20, 5), _gm(60, 5), _gm(81, 3)]  # gaps: 1, 9, 35, 16 minutes
    assign_sessions(gs)
    assert [(g["session"], g["k"]) for g in gs] == [(1, 1), (1, 2), (1, 3), (2, 1), (3, 1)]


def test_duration_uses_both_clocks():
    g = {"moves": "e2e4 e7e5 g1f3 b8c6", "base_s": 60, "inc_s": 1, "clocks": [59.0, 58.0, 55.0, 50.0]}
    # white: 60 + 2*1 - 55 = 7; black: 60 + 2*1 - 50 = 12
    assert game_duration_s(g) == 19.0


def test_bootstrap_is_deterministic_and_brackets_the_estimate():
    a = [(3, 10)] * 40 + [(1, 10)] * 40
    b = [(1, 10)] * 80
    r1, r2 = boot_diff(a, b), boot_diff(a, b)
    assert r1 == r2
    d, lo, hi = r1
    assert abs(d - 0.1) < 1e-9 and lo < d < hi and lo > 0
    d, lo, hi = diff_ci(30, 100, 30, 100)
    assert d == 0 and lo < 0 < hi


# ---------------------------------------------------------------- position pass and leaks

def _game(i, moves, color="white", result="loss"):
    me, opp = ("jakeb3ckman", "opp") if color == "white" else ("opp", "jakeb3ckman")
    return {"id": f"chesscom:{i}", "site": "chesscom", "site_id": str(i), "url": f"https://www.chess.com/game/live/{i}",
            "ended_at": f"2026-10-{10 + i:02d}T12:00:00Z", "time_class": "blitz", "base_s": 180, "inc_s": 0,
            "rated": True, "my_color": color, "white": {"name": me, "rating": 1000}, "black": {"name": opp, "rating": 1000},
            "result": "0-1", "my_result": result, "termination": "x", "moves": moves, "clocks": []}


def _store(tmp_path):
    store = Store(tmp_path / "data")
    lines = ["1. e4 e5 2. Qh5 Nc6 3. Bc4", "1. e4 e5 2. Qh5 Nf6 3. Qxe5+", "1. e4 e5 2. Qh5 d6 3. Bc4",
             "1. e4 e5 2. Nf3 Nc6 3. Bb5", "1. d4 d5 2. c4"]
    for i, ln in enumerate(lines):
        store.add_game(_game(i, uci(ln), result="win" if i == 3 else "loss"))
    return store


def test_collect_positions_counts_games_and_my_moves(tmp_path, settings):
    store = _store(tmp_path)
    ps = collect_positions(store, settings)
    after_e5 = chess.Board()
    after_e5.push_san("e4")
    after_e5.push_san("e5")
    start = chess.Board().epd()
    assert ps[start]["games"] == 5 and ps[start]["moves"]["e2e4"] == 4
    assert ps[after_e5.epd()]["games"] == 4 and ps[after_e5.epd()]["moves"] == {"d1h5": 3, "g1f3": 1}
    # Positions reached in fewer than 3 games are not searched.
    assert all(v["games"] >= 3 for v in ps.values())


@needs_engine
def test_position_pass_is_write_once_and_finds_extra_moves(tmp_path, settings):
    settings["positions"]["nodes"] = 20000
    store = _store(tmp_path)
    first = pending_work(store, settings)
    assert all(mv is None for _, mv in first)  # top-5 searches first
    res = run_positions(store, settings, workers=1)
    assert res["errors"] == [] and res["searches"] == len(first)
    # Second round: repeated moves of mine that weren't in the top 5.
    run_positions(store, settings, workers=1)
    assert pending_work(store, settings) == []
    for epd in collect_positions(store, settings):
        p = position_path(store.data, epd)
        before = p.read_text()
        pos = load_position(store.data, epd)
        assert len(pos["lines"]) >= 1 and pos["engine"]["nodes"] == 20000
        assert set(collect_positions(store, settings)[epd]["moves"]) - set(move_scores(pos)) <= {
            m for m, n in collect_positions(store, settings)[epd]["moves"].items() if n < 2}
        run_positions(store, settings, workers=1)
        assert p.read_text() == before  # never rewritten


@needs_engine
def test_leaks_and_leak_cards_follow_the_stored_scores(tmp_path, settings):
    from coach.classify import win_pct
    settings["positions"]["nodes"] = 20000
    store = _store(tmp_path)
    for _ in range(2):
        run_positions(store, settings, workers=1)
    games = list(store.iter_games())
    out, cards = build_openings(games, store.data, settings, set())
    os_ = settings["openings"]
    for lk in out["leaks"]:
        b = chess.Board(lk["fen"])
        pos = load_position(store.data, b.epd())
        sc = move_scores(pos)
        wb = win_pct(pos["lines"][0][0], lk["color"])
        drop = round(wb - win_pct(sc[lk["move"]]["score"], lk["color"]), 1)
        assert lk["drop"] == drop >= os_["leak_min_drop"]
        assert lk["kind"] == ("error" if drop >= os_["leak_error_drop"] else "repertoire")
        assert lk["played"] >= 2 and lk["reached"] >= 3
        if lk["kind"] == "repertoire":
            assert lk["card"] is None
    for c in cards:
        assert c["deck"] == "opening" and c["solution"] == c["right"][0]
        assert c["game"]["move"] not in c["right"]
        assert all(a["behind"] <= os_["right_within"] for a in c["alts"] if a["u"] in c["right"])
        assert all(chess.Move.from_uci(a["u"]) in chess.Board(c["fen"]).legal_moves for a in c["alts"])
    # Progress: every leak position is placed in a group, and its counts add up.
    placed = [l for col in out["groups"].values() for r in col for l in r["progress"]["leaks"]]
    assert {l["node"] for l in placed} == {lk["node"] for lk in out["leaks"]}
    for l in placed:
        for per in ("before", "since"):
            p = l[per]
            assert p["good"] + p["old"] + p["other"] + p["unchecked"] == p["n"]
        assert l["before"]["n"] + l["since"]["n"] == next(n["games"] for k, n in out["nodes"].items() if k == l["node"])
    # The synthetic games all end before the default training start: nothing counts as "since".
    assert all(r["progress"]["blunders"]["since"]["games"] == 0 for col in out["groups"].values() for r in col)
    assert sum(r["progress"]["blunders"]["before"]["games"] for col in out["groups"].values() for r in col) == 0  # no analysis files here
    # Openings tree: every move's child link points at a node that exists.
    for n in out["nodes"].values():
        assert all(m["to"] is None or m["to"] in out["nodes"] for m in n["moves"])
