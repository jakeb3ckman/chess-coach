"""The position pass (Phase 3): a deeper, multi-line Stockfish search of every
opening position I reach often, for opening leaks, leak cards and the engine's
other good moves in the Openings screen (docs/phase-3-plan.md, A.4).

Which positions: I am to move, within my first 15 moves (ply < 30), and the
position (pieces, side to move, castling rights, legal en passant) was reached
in at least 3 of my games.

What is searched, with Stockfish's hash cleared before each search:
  - the position, MultiPV 5 at 5M nodes, one thread;
  - every move I played there at least twice that is not one of those 5 lines,
    as a search restricted to that move, with the same node budget.

The position is searched from its own FEN (move counters reset), not from a
game's move history, so a position has one result whichever game reached it.

Storage, written once and never rewritten (like analysis files):
  data/positions/{h[:2]}/{h}.json          top 5 lines
  data/positions/{h[:2]}/{h}-{uci}.json     one extra move
where h = first 16 hex digits of sha1(EPD). Games are never re-analyzed.
"""
from __future__ import annotations

import hashlib
import json
import multiprocessing as mp
import time
from collections import Counter, defaultdict
from pathlib import Path

import chess
import chess.engine

from .engine import encode_score, open_engine

POSITIONS_FORMAT = 1


def pos_hash(epd: str) -> str:
    return hashlib.sha1(epd.encode()).hexdigest()[:16]


def board_of(epd: str) -> chess.Board:
    return chess.Board(f"{epd} 0 1")


def position_path(data: Path, epd: str, move: str | None = None) -> Path:
    h = pos_hash(epd)
    return data / "positions" / h[:2] / (f"{h}-{move}.json" if move else f"{h}.json")


def collect_positions(store, settings: dict) -> dict[str, dict]:
    """EPD -> {"games": n, "moves": Counter(uci -> times I played it)} for every
    qualifying position (I am to move, ply < max_ply, reached in >= min_games games)."""
    ps = settings["positions"]
    reached: dict[str, set] = defaultdict(set)
    moves: dict[str, Counter] = defaultdict(Counter)
    for g in store.iter_games():
        par = 0 if g["my_color"] == "white" else 1
        b = chess.Board()
        for i, mv in enumerate(g["moves"].split()[:ps["max_ply"]]):
            if i % 2 == par:
                k = b.epd()
                reached[k].add(g["id"])
                moves[k][mv] += 1
            b.push_uci(mv)
    return {k: {"games": len(v), "moves": moves[k]} for k, v in reached.items() if len(v) >= ps["min_games"]}


def load_position(data: Path, epd: str) -> dict | None:
    p = position_path(data, epd)
    if not p.exists():
        return None
    with open(p) as f:
        out = json.load(f)
    out["extra"] = {}
    for q in p.parent.glob(f"{p.stem}-*.json"):
        with open(q) as f:
            e = json.load(f)
        out["extra"][e["move"]] = e
    return out


def pending_work(store, settings: dict, shard: int = 0, shards: int = 1) -> list[tuple[str, str | None]]:
    """(epd, None) for a position without its top-5 file; (epd, uci) for a
    repeated move of mine missing from the top 5 and from the extra files.
    Extra moves wait until the top-5 file exists (next run if it was just made)."""
    ps = settings["positions"]
    todo = []
    for epd, info in sorted(collect_positions(store, settings).items()):
        if int(pos_hash(epd), 16) % shards != shard:
            continue
        top = load_position(store.data, epd)
        if top is None:
            todo.append((epd, None))
            continue
        listed = {ln[2].split()[0] for ln in top["lines"] if ln[2]} | set(top["extra"])
        for mv, n in info["moves"].items():
            if n >= ps["min_played_for_extra"] and mv not in listed:
                todo.append((epd, mv))
    return todo


def search(eng, epd: str, move: str | None, settings: dict) -> dict:
    ps = settings["positions"]
    b = board_of(epd)
    t = time.monotonic()
    limit = chess.engine.Limit(nodes=ps["nodes"])
    eng_info = {"name": "Stockfish 19", "threads": settings["engine"]["threads"],
                "hash_mb": settings["engine"]["hash_mb"], "nodes": ps["nodes"]}
    if move is None:
        infos = eng.analyse(b, limit, multipv=ps["multipv"], game=object())
        lines = [[encode_score(i["score"]), i.get("depth"), " ".join(m.uci() for m in i.get("pv", [])[:ps["pv_max_plies"]])]
                 for i in infos]
        return {"format": POSITIONS_FORMAT, "epd": epd, "engine": {**eng_info, "multipv": ps["multipv"]},
                "lines": lines, "secs": round(time.monotonic() - t, 2)}
    info = eng.analyse(b, limit, root_moves=[chess.Move.from_uci(move)], game=object())
    return {"format": POSITIONS_FORMAT, "epd": epd, "move": move, "engine": eng_info,
            "score": encode_score(info["score"]), "depth": info.get("depth"),
            "pv": " ".join(m.uci() for m in info.get("pv", [])[:ps["pv_max_plies"]]),
            "secs": round(time.monotonic() - t, 2)}


def _worker(settings, tasks, results):
    eng = open_engine(settings)
    try:
        while (task := tasks.get()) is not None:
            epd, move = task
            try:
                results.put((epd, move, search(eng, epd, move, settings), None))
            except Exception as e:  # noqa: BLE001 - reported, the position is retried next run
                results.put((epd, move, None, repr(e)))
    finally:
        eng.quit()


def run_positions(store, settings: dict, *, shard=0, shards=1, workers=1, deadline=None,
                  commit=False, push=True, log=print) -> dict:
    from .runner import git_commit_push  # local import: runner imports engine helpers too
    from .store import Store
    todo = pending_work(store, settings, shard, shards)
    batch = settings["positions"]["commit_every"]
    done, errors, paths, secs = 0, [], [], 0.0
    ctx = mp.get_context("spawn")
    tasks, results = ctx.Queue(), ctx.Queue()
    procs = [ctx.Process(target=_worker, args=(settings, tasks, results), daemon=True) for _ in range(max(1, workers))]
    for p in procs:
        p.start()
    it = iter(todo)
    inflight = 0

    def submit():
        nonlocal inflight
        if deadline is not None and time.monotonic() >= deadline:
            return
        nxt = next(it, None)
        if nxt is not None:
            tasks.put(nxt)
            inflight += 1

    def flush():
        nonlocal paths
        if commit and paths:
            git_commit_push(paths, f"positions: shard {shard}/{shards}, {len(paths)} searches", store.data.parent, push=push)
        paths = []

    try:
        for _ in procs:
            submit()
        while inflight:
            epd, move, res, err = results.get()
            inflight -= 1
            if err is None:
                path = position_path(store.data, epd, move)
                if not path.exists():  # write once
                    Store.write_json_atomic(path, res)
                    paths.append(path)
                secs += res["secs"]
                done += 1
            else:
                errors.append({"epd": epd, "move": move, "error": err})
            if len(paths) >= batch:
                flush()
                log(f"[positions {shard}/{shards}] {done}/{len(todo)} searches")
            submit()
    finally:
        for _ in procs:
            tasks.put(None)
        for p in procs:
            p.join(timeout=30)
            if p.is_alive():
                p.terminate()
    flush()
    return {"searches": done, "todo": len(todo), "errors": errors, "engine_s": round(secs, 1),
            "remaining": len(pending_work(store, settings, shard, shards))}
