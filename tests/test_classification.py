"""Classification rules.

Per the approved spec, these tests use bare numbers with no position attached
(arithmetic on the rules, not chess judgments). Tests that need a position plus
an evaluation use real Stockfish output from tests/fixtures/engine/.
"""
import pytest

from coach.build import build_cards, derive_mistakes, order_new_cards
from coach.classify import card_exclusions, label, time_trouble_threshold, win_pct, win_pct_white

from .conftest import engine_fixture


# ---- Win% (Lichess formula)
def test_win_pct_formula_basics():
    assert win_pct_white(0) == pytest.approx(50.0)
    assert win_pct_white(300) == pytest.approx(100 - win_pct_white(-300))
    assert win_pct_white(1500) == win_pct_white(1000)  # clamped like Lichess (Cp.CEILING)
    assert win_pct_white("M+3") == win_pct_white(1000)  # mate -> +-1000 cp
    assert win_pct_white("M-2") == win_pct_white(-1000)
    assert win_pct(200, "black") == pytest.approx(100 - win_pct(200, "white"))
    # spot value from the formula 50 + 50*(2/(1+exp(-0.00368208*cp)) - 1)
    assert win_pct_white(100) == pytest.approx(59.1, abs=0.05)


def test_drop_in_decided_positions_is_small():
    """The reason for Win%: the same 300 cp loss matters less when the game is decided."""
    equal_game = win_pct_white(0) - win_pct_white(-300)
    decided_game = win_pct_white(900) - win_pct_white(600)
    assert equal_game > 25 and decided_game < 7


# ---- labels (5 / 10 / 15 Win% points)
@pytest.mark.parametrize("drop,expected", [
    (4.99, None), (5.0, "inaccuracy"), (9.99, "inaccuracy"), (10.0, "mistake"),
    (14.99, "mistake"), (15.0, "blunder"), (60.0, "blunder"),
])
def test_label_thresholds(settings, drop, expected):
    assert label(drop, settings["labels"]) == expected


# ---- card rules
def base_mistake(**kw):
    m = dict(label="blunder", source_pass=2, win_before=50.0, win_after=20.0,
             second_best_gap=30.0, clock_before_s=100.0, base_s=600)
    m.update(kw)
    return m


def test_clean_mistake_is_eligible(settings):
    assert card_exclusions(base_mistake(), settings["cards"]) == []


def test_inaccuracy_and_pass1_only_are_excluded(settings):
    c = settings["cards"]
    assert "below_min_label" in card_exclusions(base_mistake(label="inaccuracy"), c)
    assert "no_deep_check" in card_exclusions(base_mistake(source_pass=1), c)
    assert card_exclusions(base_mistake(label="mistake"), c) == []


def test_best_move_must_be_clearly_best(settings):
    c = settings["cards"]
    assert "best_not_clearly_best" in card_exclusions(base_mistake(second_best_gap=14.9), c)
    assert card_exclusions(base_mistake(second_best_gap=15.0), c) == []
    assert card_exclusions(base_mistake(second_best_gap=None), c) == []  # only one legal move


def test_already_decided_rules(settings):
    c = settings["cards"]
    assert "already_lost" in card_exclusions(base_mistake(win_before=9.9, win_after=1), c)
    assert card_exclusions(base_mistake(win_before=10.0, win_after=1), c) == []
    assert card_exclusions(base_mistake(win_before=90.0, win_after=60), c) == []
    # still winning after the slip -> already won, excluded
    assert "already_won" in card_exclusions(base_mistake(win_before=97, win_after=75), c)
    # threw the win away (dropped below 50) -> eligible (approved exception)
    assert card_exclusions(base_mistake(win_before=97, win_after=49.9), c) == []
    assert "already_won" in card_exclusions(base_mistake(win_before=97, win_after=50.0), c)


@pytest.mark.parametrize("base,expected", [(60, 6.0), (120, 12.0), (180, 15.0), (300, 15.0), (600, 15.0)])
def test_time_trouble_threshold_by_time_control(settings, base, expected):
    assert time_trouble_threshold(base, settings["cards"]) == pytest.approx(expected)


def test_time_trouble_excludes_and_is_a_setting(settings):
    c = settings["cards"]
    assert "time_trouble" in card_exclusions(base_mistake(base_s=60, clock_before_s=5.9), c)
    assert card_exclusions(base_mistake(base_s=60, clock_before_s=6.0), c) == []
    assert card_exclusions(base_mistake(clock_before_s=None), c) == []  # unknown clock: keep
    c["time_trouble_max_s"] = 3
    assert card_exclusions(base_mistake(base_s=60, clock_before_s=5.9), c) == []


# ---- new-card order: occurrences, then recency, then drop
def test_new_card_order():
    cards = [
        {"id": "a", "n_occurrences": 1, "latest_at": "2026-11-10", "max_drop": 50},
        {"id": "b", "n_occurrences": 2, "latest_at": "2026-01-01", "max_drop": 11},
        {"id": "c", "n_occurrences": 1, "latest_at": "2026-11-12", "max_drop": 12},
        {"id": "d", "n_occurrences": 1, "latest_at": "2026-11-12", "max_drop": 40},
    ]
    assert [c["id"] for c in order_new_cards(cards)] == ["b", "d", "c", "a"]


# ---- with real engine output
def test_derived_mistakes_use_stored_engine_output(settings):
    game, analysis = engine_fixture("187124656900")
    ms = derive_mistakes(game, analysis, settings)
    assert ms
    for m in ms:
        assert m["drop"] >= settings["labels"]["inaccuracy"]
        assert m["my_move"] != m["best_move"]  # playing the engine's move is never a mistake
        if m["source_pass"] == 2:
            deep = analysis["p2"][str(m["ply"])]
            assert m["best_line"] == deep["lines"][0][2]
            assert m["score_after"] == deep["after"]
        assert (m["ply"] % 2 == 0) == (game["my_color"] == "white")


def test_cards_dedupe_same_position_across_games(settings):
    game, analysis = engine_fixture("186778591044")
    twin = dict(game, id="chesscom:twin", site_id="twin", ended_at="2026-11-12T00:00:00Z")
    ms = derive_mistakes(game, analysis, settings) + derive_mistakes(twin, analysis, settings)
    eligible = [m for m in ms if not m["excluded_by"]]
    assert eligible
    cards = build_cards(ms)
    assert len(cards) == len(eligible) // 2
    for c in cards:
        assert c["n_occurrences"] == 2
        assert {o["game_id"] for o in c["occurrences"]} == {game["id"], "chesscom:twin"}
        assert c["occurrences"][0]["ended_at"] >= c["occurrences"][1]["ended_at"]
