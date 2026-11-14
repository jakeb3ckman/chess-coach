"""Resumable, sharded analysis. Uses the real Stockfish binary with tiny node
budgets: these tests check plumbing (resume, shards, batches, repeatability),
not chess quality."""
import json
import subprocess

import pytest

from coach.engine import analyze_game, open_engine
from coach.runner import pending_games, run_analysis, shard_of
from coach.store import Store

from .conftest import engine_fixture, needs_engine

pytestmark = needs_engine


def make_store(tmp_path, chesscom_games, settings):
    from coach.games import SkipGame, normalize_chesscom
    store = Store(tmp_path / "data")
    for raw in chesscom_games:
        try:
            store.add_game(normalize_chesscom(raw, "jakeb3ckman", settings["import"]["time_classes"]))
        except SkipGame:
            pass
    return store


def test_shards_partition_games(tmp_path, chesscom_games, fast_engine_settings):
    store = make_store(tmp_path, chesscom_games, fast_engine_settings)
    all_ids = {g["id"] for g in pending_games(store)}
    parts = [{g["id"] for g in pending_games(store, i, 4)} for i in range(4)]
    assert set().union(*parts) == all_ids
    assert sum(len(p) for p in parts) == len(all_ids)  # disjoint
    assert all(shard_of(gid, 4) == i for i, p in enumerate(parts) for gid in p)


def test_resume_skips_finished_games(tmp_path, chesscom_games, fast_engine_settings):
    store = make_store(tmp_path, chesscom_games, fast_engine_settings)
    total = len(pending_games(store))
    r1 = run_analysis(store, fast_engine_settings, workers=2, limit=2, log=lambda *_: None)
    assert r1["done"] == 2 and r1["remaining"] == total - 2
    newest = sorted(store.iter_games(), key=lambda g: g["ended_at"], reverse=True)[:2]
    assert all(store.has_analysis(g) for g in newest)  # newest first
    r2 = run_analysis(store, fast_engine_settings, workers=2, log=lambda *_: None)
    assert r2["done"] == total - 2 and r2["remaining"] == 0
    r3 = run_analysis(store, fast_engine_settings, workers=2, log=lambda *_: None)
    assert r3["done"] == 0  # nothing is ever re-analyzed


def test_zero_budget_starts_nothing(tmp_path, chesscom_games, fast_engine_settings):
    store = make_store(tmp_path, chesscom_games, fast_engine_settings)
    r = run_analysis(store, fast_engine_settings, workers=2, budget_s=0, log=lambda *_: None)
    assert r["done"] == 0 and r["remaining"] == len(pending_games(store))


def test_existing_analysis_is_never_overwritten(tmp_path, chesscom_games, fast_engine_settings):
    store = make_store(tmp_path, chesscom_games, fast_engine_settings)
    g = next(store.iter_games())
    store.save_analysis(g, {"format": 1})
    with pytest.raises(FileExistsError):
        store.save_analysis(g, {"format": 1})


def test_commits_after_every_batch(tmp_path, chesscom_games, fast_engine_settings):
    repo = tmp_path
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "test"], cwd=repo, check=True)
    store = make_store(tmp_path, chesscom_games, fast_engine_settings)
    fast_engine_settings["analysis_jobs"]["batch_games"] = 2
    r = run_analysis(store, fast_engine_settings, workers=2, commit=True, push=False, log=lambda *_: None)
    log = subprocess.run(["git", "log", "--format=%s"], cwd=repo, capture_output=True, text=True).stdout.split("\n")
    commits = [l for l in log if l.startswith("analysis:")]
    assert r["done"] == 6 and len(commits) == 3  # 2 + 2 + 2: a killed job loses at most one batch
    tracked = subprocess.run(["git", "ls-files"], cwd=repo, capture_output=True, text=True).stdout.split()
    assert len([t for t in tracked if t.startswith("data/analysis/")]) == 6


def test_repeatable_results(fast_engine_settings):
    game, _ = engine_fixture("186778591044")
    eng = open_engine(fast_engine_settings)
    try:
        a = analyze_game(game, fast_engine_settings, eng)
        b = analyze_game(game, fast_engine_settings, eng)  # same engine, hash state differs
    finally:
        eng.quit()
    eng2 = open_engine(fast_engine_settings)
    try:
        c = analyze_game(game, fast_engine_settings, eng2)  # fresh engine process
    finally:
        eng2.quit()
    for x in (b, c):
        assert (a["p1"], a["pv1"], a["p2"]) == (x["p1"], x["pv1"], x["p2"])


def test_analysis_file_is_compact(tmp_path, chesscom_games, fast_engine_settings):
    store = make_store(tmp_path, chesscom_games, fast_engine_settings)
    run_analysis(store, fast_engine_settings, workers=1, limit=1, log=lambda *_: None)
    p = next((store.data / "analysis").glob("*/*/*.json"))
    text = p.read_text()
    assert text.count("\n") == 1 and "fen" not in text  # no FENs stored; rebuilt from moves
    assert json.loads(text)["engine"]["name"].startswith("Stockfish")


def test_failed_game_is_recorded_not_retried(tmp_path, chesscom_games, fast_engine_settings):
    store = make_store(tmp_path, chesscom_games, fast_engine_settings)
    bad = dict(next(store.iter_games()), id="chesscom:bad", site_id="bad", moves="e2e4 e2e4")  # illegal
    store.add_game(bad)
    r = run_analysis(store, fast_engine_settings, workers=2, log=lambda *_: None)
    assert [f["id"] for f in r["failed"]] == ["chesscom:bad"]
    assert store.has_failure(bad) and r["remaining"] == 0
    assert run_analysis(store, fast_engine_settings, workers=2, log=lambda *_: None)["done"] == 0


def test_deep_all_checks_every_move_and_matches_pipeline(fast_engine_settings):
    """Used only by scripts/screen_miss_check.py: every one of my moves gets a deep
    check, and the moves the pipeline deep-checks come out identical."""
    game, _ = engine_fixture("186778591044")
    eng = open_engine(fast_engine_settings)
    try:
        normal = analyze_game(game, fast_engine_settings, eng)
        full = analyze_game(game, fast_engine_settings, eng, deep_all=True)
    finally:
        eng.quit()
    parity = 0 if game["my_color"] == "white" else 1
    my_plies = {str(i) for i in range(len(game["moves"].split())) if i % 2 == parity}
    assert set(full["p2"]) == my_plies
    assert all(full["p2"][k] == v for k, v in normal["p2"].items())
    assert full["p1"] == normal["p1"] and full.get("deep_all") is True and "deep_all" not in normal
