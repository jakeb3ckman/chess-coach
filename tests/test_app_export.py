"""The app's card file: only what a card needs, built from real Stockfish fixtures."""
import json

import chess

from coach.build import app_cards, build_cards, derive_mistakes, game_link

from .conftest import engine_fixture


def _cards(settings):
    out = []
    for gid in ("186778591044", "187124656900"):
        game, analysis = engine_fixture(gid)
        out += derive_mistakes(game, analysis, settings)
    return build_cards(out)


def test_app_cards_hold_only_card_fields(settings):
    cards = _cards(settings)
    assert cards, "fixtures should yield at least one card"
    app = app_cards(cards)
    assert app["format"] == 1
    assert [c["id"] for c in app["cards"]] == [c["card_id"] for c in cards]  # order kept
    for c in app["cards"]:
        assert set(c) == {"id", "deck", "fen", "solution", "line", "color", "prev", "occ"}
        board = chess.Board(c["fen"])
        assert board.turn == (c["color"] == "white")
        assert chess.Move.from_uci(c["solution"]) in board.legal_moves
        assert c["line"].split()[0] == c["solution"]
        for o in c["occ"]:
            assert set(o) == {"link", "site", "move", "drop", "label", "tc", "at"}
    text = json.dumps(app)
    assert '"p1"' not in text and '"p2"' not in text and "clocks" not in text


def test_prev_move_leads_to_card_position(settings):
    for gid in ("186778591044", "187124656900"):
        game, analysis = engine_fixture(gid)
        moves = game["moves"].split()
        for m in derive_mistakes(game, analysis, settings):
            board = chess.Board()
            for u in moves[:m["ply"]]:
                board.push_uci(u)
            assert board.fen() == m["fen_before"]
            assert m["prev_move"] == (moves[m["ply"] - 1] if m["ply"] else None)


def test_game_links():
    lichess = {"url": "https://lichess.org/Rcw8jdVY", "ply": 19}
    assert game_link(lichess, "black") == "https://lichess.org/Rcw8jdVY/black#19"
    cc = {"url": "https://www.chess.com/game/live/172376371310", "ply": 5}
    assert game_link(cc, "black") == "https://www.chess.com/game/live/172376371310"
