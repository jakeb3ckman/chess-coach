"""Parsing and normalization of real API output from both sites."""
import copy

import chess
import pytest

from coach.games import SkipGame, normalize_chesscom, normalize_lichess, parse_time_control

TCS = ["bullet", "blitz", "rapid"]


def test_time_control_parsing():
    assert parse_time_control("600") == (600, 0)
    assert parse_time_control("120+1") == (120, 1)
    assert parse_time_control("180+2") == (180, 2)
    with pytest.raises(SkipGame):
        parse_time_control("1/86400")  # daily


def test_chesscom_normalizes_every_live_game(chesscom_games):
    live = [g for g in chesscom_games if g["time_class"] != "daily"]
    assert len(live) == 6
    for raw in live:
        g = normalize_chesscom(raw, "jakeb3ckman", TCS)
        assert g["id"] == f"chesscom:{raw['url'].rstrip('/').split('/')[-1]}"
        assert g["site"] == "chesscom" and g["url"] == raw["url"]
        assert g["time_class"] == raw["time_class"]
        assert g["my_color"] in ("white", "black")
        assert g[g["my_color"]]["name"].lower() == "jakeb3ckman"
        moves = g["moves"].split()
        assert len(moves) == len(g["clocks"]) > 0
        assert all(c is not None for c in g["clocks"])  # every chess.com live game has %clk
        board = chess.Board()
        for u in moves:  # every move is legal from the standard start
            board.push_uci(u)
        assert g["result"] in ("1-0", "0-1", "1/2-1/2")
        assert g["my_result"] in ("win", "loss", "draw")
        assert g["ended_at"].endswith("Z")


def test_chesscom_clock_values_match_pgn(chesscom_games):
    raw = next(g for g in chesscom_games if g["time_class"] == "bullet")
    g = normalize_chesscom(raw, "jakeb3ckman", TCS)
    # first clock comment in the PGN, parsed independently
    first = raw["pgn"].split("[%clk ")[1].split("]")[0]
    h, m, s = first.split(":")
    assert g["clocks"][0] == round(int(h) * 3600 + int(m) * 60 + float(s), 1)
    assert max(g["clocks"]) <= g["base_s"] + g["inc_s"] * len(g["clocks"])


def test_chesscom_skips_daily_variants_and_custom_starts(chesscom_games):
    daily = next(g for g in chesscom_games if g["time_class"] == "daily")
    with pytest.raises(SkipGame):
        normalize_chesscom(daily, "jakeb3ckman", TCS)
    live = next(g for g in chesscom_games if g["time_class"] == "blitz")
    variant = copy.deepcopy(live)
    variant["rules"] = "chess960"
    with pytest.raises(SkipGame):
        normalize_chesscom(variant, "jakeb3ckman", TCS)
    custom = copy.deepcopy(live)
    custom["initial_setup"] = "8/8/8/8/8/8/8/K6k w - - 0 1"
    with pytest.raises(SkipGame):
        normalize_chesscom(custom, "jakeb3ckman", TCS)


def test_chesscom_username_is_case_insensitive(chesscom_games):
    raw = next(g for g in chesscom_games if g["time_class"] == "rapid")
    assert normalize_chesscom(raw, "JakeB3ckman", TCS)["my_color"] == normalize_chesscom(raw, "jakeb3ckman", TCS)["my_color"]


def test_lichess_normalizes_pool_games(lichess_games):
    pool = [g for g in lichess_games if g.get("source") == "pool"]
    assert len(pool) == 6
    for raw in pool:
        g = normalize_lichess(raw, "jbeck1026", TCS)
        assert g["id"] == f"lichess:{raw['id']}"
        assert g["url"] == f"https://lichess.org/{raw['id']}"
        assert g["time_class"] == raw["speed"]
        assert g["base_s"] == raw["clock"]["initial"] and g["inc_s"] == raw["clock"]["increment"]
        assert len(g["moves"].split()) == len(g["clocks"]) > 0
        assert g[g["my_color"]]["name"].lower() == "jbeck1026"


def test_lichess_skips_computer_and_correspondence(lichess_games):
    others = [g for g in lichess_games if g.get("source") != "pool"]
    assert others
    for raw in others:
        with pytest.raises(SkipGame):
            normalize_lichess(raw, "jbeck1026", TCS)


def test_lichess_moves_match_api_move_list(lichess_games):
    for raw in (g for g in lichess_games if g.get("source") == "pool"):
        g = normalize_lichess(raw, "jbeck1026", TCS)
        board = chess.Board()
        san = []
        for u in g["moves"].split():
            mv = chess.Move.from_uci(u)
            san.append(board.san(mv))
            board.push(mv)
        assert " ".join(san) == raw["moves"]  # API's own SAN list
