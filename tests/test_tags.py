"""Tags come from stored engine output plus legal-move facts. Engine data here is
real Stockfish output (tests/fixtures/engine); the formatting tests use bare numbers."""
import chess

from coach.build import derive_mistakes
from coach.tags import TAG_ORDER, eval_text, full_line_loss, hung_piece_loss, material, mate_for, winning_capture_gain

from .conftest import engine_fixture, engine_refutation


def _mistakes(settings):
    out = []
    for gid in ("186778591044", "187124656900"):
        game, analysis = engine_fixture(gid)
        out += derive_mistakes(game, analysis, settings, engine_refutation(gid))
    return out


def test_refutation_scores_match_stored_after_search(settings):
    deep = [m for m in _mistakes(settings) if m["source_pass"] == 2]
    assert deep
    assert all(m["refutation_matches"] is True for m in deep)
    assert all(m["refutation_line"] for m in deep)


def test_tags_follow_their_rules(settings):
    cards = settings["cards"]
    for m in _mistakes(settings):
        t = set(m["tags"])
        assert t <= set(TAG_ORDER)
        assert ("opening" in t) == (m["move_number"] <= 10)
        assert ("thrown win" in t) == (m["win_before"] > cards["decided_high"] and m["win_after"] < cards["thrown_win_below"])
        board = chess.Board(m["fen_before"])
        gain = winning_capture_gain(m)
        assert ("missed winning capture" in t) == (gain is not None and gain >= 3)
        if "missed winning capture" in t:
            assert board.is_capture(chess.Move.from_uci(m["best_move"]))
        loss = full_line_loss(m)
        assert ("loses material" in t) == (loss is not None and loss >= 3)
        assert ("mate" in t) == (mate_for(m["score_before"], m["my_color"]) is not None)
        if m["refutation_line"] is None:
            assert "hung piece" not in t


def test_hung_piece_needs_a_capture_of_my_piece_first(settings):
    for m in _mistakes(settings):
        loss = hung_piece_loss(m)
        if not m["refutation_line"]:
            assert loss is None
            continue
        board = chess.Board(m["fen_before"])
        me = board.turn
        board.push_uci(m["my_move"])
        first = chess.Move.from_uci(m["refutation_line"].split()[0])
        victim = board.piece_at(first.to_square)
        if victim is None or victim.color != me or victim.piece_type in (chess.PAWN, chess.KING):
            assert loss is None
        else:
            assert isinstance(loss, int)


def test_material_count():
    assert material(chess.Board(), chess.WHITE) == 0
    b = chess.Board("4k3/8/8/8/8/8/8/R3K2Q w - - 0 1")
    assert material(b, chess.WHITE) == 14 and material(b, chess.BLACK) == -14


def test_eval_text_is_from_my_side():
    assert eval_text(153, "white") == "+1.53"
    assert eval_text(153, "black") == "-1.53"
    assert eval_text(-463, "white") == "-4.63"
    assert eval_text("M+3", "white") == "M3"
    assert eval_text("M+3", "black") == "-M3"
    assert eval_text("M-2", "black") == "M2"
    assert eval_text(0, "black") == "+0.00"


def test_full_line_loss_plays_the_whole_refutation(settings):
    for m in _mistakes(settings):
        if not m["refutation_line"]:
            continue
        board = chess.Board(m["fen_before"])
        me = board.turn
        start = material(board, me)
        board.push_uci(m["my_move"])
        for u in m["refutation_line"].split():
            board.push_uci(u)
        assert full_line_loss(m) == start - material(board, me)
