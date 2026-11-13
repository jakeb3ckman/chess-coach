"""Resumable, shardable analysis runner.

- Shard i of N takes only games with hash(game_id) mod N == i, so parallel jobs
  write disjoint files and their git pushes never conflict.
- Newest games first.
- Each finished game is written atomically right away. With commit=True the
  runner commits and pushes after every `batch` finished games, so a killed job
  loses at most one batch.
- New games stop being started once the time budget is used up.
"""
from __future__ import annotations

import hashlib
import multiprocessing as mp
import queue
import subprocess
import time
import traceback

from .engine import analyze_game, open_engine
from .store import Store


def _worker_loop(settings, tasks, results):
    eng = open_engine(settings)
    try:
        while True:
            g = tasks.get()
            if g is None:
                return
            try:
                results.put((g, analyze_game(g, settings, eng), None))
            except Exception:
                results.put((g, None, traceback.format_exc(limit=3)))
    finally:
        eng.quit()


def shard_of(game_id: str, n: int) -> int:
    return int(hashlib.sha1(game_id.encode()).hexdigest(), 16) % n


def pending_games(store: Store, shard: int = 0, shards: int = 1) -> list[dict]:
    todo = [g for g in store.iter_games()
            if shard_of(g["id"], shards) == shard and not store.has_analysis(g) and not store.has_failure(g)]
    todo.sort(key=lambda g: g["ended_at"], reverse=True)
    return todo


def git_commit_push(paths, message: str, cwd, push: bool = True, retries: int = 5) -> None:
    subprocess.run(["git", "add", "--", *map(str, paths)], cwd=cwd, check=True)
    subprocess.run(["git", "commit", "-q", "-m", message], cwd=cwd, check=True)
    if not push:
        return
    for attempt in range(retries):
        subprocess.run(["git", "pull", "--rebase", "-q"], cwd=cwd, check=True)
        if subprocess.run(["git", "push", "-q"], cwd=cwd).returncode == 0:
            return
        time.sleep(5 * (attempt + 1))
    raise RuntimeError("git push failed after retries")


def run_analysis(store: Store, settings: dict, *, shard=0, shards=1, workers=1,
                 budget_s=None, limit=None, commit=False, push=True, log=print) -> dict:
    jobs = settings["analysis_jobs"]
    batch = jobs["batch_games"]
    budget_s = budget_s if budget_s is not None else jobs["budget_minutes"] * 60
    todo = pending_games(store, shard, shards)
    if limit is not None:
        todo = todo[:limit]
    deadline = time.monotonic() + budget_s
    started = time.monotonic()
    done, failed, pending_paths, engine_secs = 0, [], [], 0.0
    it = iter(todo)

    def flush():
        nonlocal pending_paths
        if commit and pending_paths:
            git_commit_push(pending_paths, f"analysis: shard {shard}/{shards}, {len(pending_paths)} games",
                            store.data.parent, push=push)
        pending_paths = []

    ctx = mp.get_context("spawn")
    tasks, results = ctx.Queue(), ctx.Queue()
    procs = [ctx.Process(target=_worker_loop, args=(settings, tasks, results), daemon=True)
             for _ in range(max(1, workers))]
    for p in procs:
        p.start()
    inflight = 0

    def submit_next():
        nonlocal inflight
        if time.monotonic() >= deadline:
            return
        g = next(it, None)
        if g is not None:
            tasks.put(g)
            inflight += 1

    try:
        for _ in procs:
            submit_next()
        while inflight:
            try:
                g, analysis, err = results.get(timeout=60)
            except queue.Empty:
                if not any(p.is_alive() for p in procs):
                    raise RuntimeError("all analysis workers died (is Stockfish installed?)")
                continue
            inflight -= 1
            if err is None:
                store.save_analysis(g, analysis)
                pending_paths.append(store.analysis_path(g))
                engine_secs += analysis["secs"]
                done += 1
            else:  # record it so it isn't retried forever; delete the marker to retry
                failed.append({"id": g["id"], "error": err})
                store.save_failure(g, err)
                pending_paths.append(store.failure_path(g))
            if len(pending_paths) >= batch:
                flush()
                log(f"[shard {shard}/{shards}] {done}/{len(todo)} games analyzed")
            submit_next()
    finally:
        for _ in procs:
            tasks.put(None)  # each worker quits its engine and exits
        for p in procs:
            p.join(timeout=30)
            if p.is_alive():
                p.terminate()
    flush()
    remaining = len(pending_games(store, shard, shards))
    return {"done": done, "failed": failed, "remaining": remaining,
            "wall_s": round(time.monotonic() - started, 1), "engine_s": round(engine_secs, 1)}
