import copy
import json
from pathlib import Path

import pytest

from coach.config import load_settings
from coach.engine import engine_path

FIX = Path(__file__).parent / "fixtures"


@pytest.fixture
def settings():
    return copy.deepcopy(load_settings())


@pytest.fixture
def chesscom_games():
    return json.loads((FIX / "chesscom_month.json").read_text())["games"]


@pytest.fixture
def lichess_games():
    return [json.loads(l) for l in (FIX / "lichess_games.ndjson").read_text().splitlines() if l.strip()]


def engine_fixture(name):
    game = json.loads((FIX / "engine" / f"{name}.game.json").read_text())
    analysis = json.loads((FIX / "engine" / f"{name}.analysis.json").read_text())
    return game, analysis


needs_engine = pytest.mark.skipif(not engine_path().exists(), reason="Stockfish not installed (tools/install_stockfish.sh)")


@pytest.fixture
def fast_engine_settings(settings):
    """Real Stockfish, tiny node budgets: for testing plumbing, not chess."""
    settings["engine"]["pass1_nodes"] = 2000
    settings["engine"]["pass2_nodes"] = 5000
    return settings
