"""How many mistakes does the pass-1 screen miss?

The pipeline deep-checks (pass 2) only moves where the quick pass 1 saw a drop of
at least `candidate_min_drop` Win% and I was at or above `candidate_min_win_before`.
This script deep-checks EVERY one of my moves in a sample of games, with exactly
the pass-2 settings, and compares the labels with what the pipeline produced
from the stored analysis.

Usage: uv run python scripts/screen_miss_check.py --sample 30 --out tmp/screen-check.json
Run on GitHub by .github/workflows/screen-check.yml.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import platform
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from coach.build import derive_mistakes  # noqa: E402
from coach.classify import LABEL_RANK, win_pct  # noqa: E402
from coach.config import load_settings  # noqa: E402
from coach.engine import analyze_game, open_engine  # noqa: E402
from coach.store import Store  # noqa: E402

SALT = "screen-check-v1"


def pick_sample(store: Store, n: int) -> list[dict]:
    """Deterministic, spread evenly over site x time control."""
    buckets: dict[tuple, list] = {}
    for g in store.iter_games():
        if store.has_analysis(g):
            buckets.setdefault((g["site"], g["time_class"]), []).append(g)
    for b in buckets.values():
        b.sort(key=lambda g: hashlib.sha1(f"{SALT}|{g['id']}".encode()).hexdigest())
    out, i = [], 0
    while len(out) < n and any(i < len(b) for b in buckets.values()):
        for key in sorted(buckets):
            if i < len(buckets[key]) and len(out) < n:
                out.append(buckets[key][i])
        i += 1
    return out


def _deep_all(game: dict, settings: dict) -> dict:
    eng = open_engine(settings)
    try:
        return analyze_game(game, settings, eng, deep_all=True)
    finally:
        eng.quit()  # python-chess keeps a non-daemon thread per engine; always quit


def cpu_model() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def rank(lab):
    return LABEL_RANK.get(lab, 0) if lab else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=30)
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--out", default="tmp/screen-check.json")
    args = ap.parse_args()
    settings = load_settings()
    e = settings["engine"]
    store = Store()
    sample = pick_sample(store, args.sample)

    t0 = time.monotonic()
    deep: dict[str, dict] = {}
    with cf.ProcessPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(_deep_all, g, settings): g for g in sample}
        for f in cf.as_completed(futs):
            g = futs[f]
            deep[g["id"]] = f.result()
            print(f"done {len(deep)}/{len(sample)} {g['id']} {deep[g['id']]['secs']}s", flush=True)
    wall = time.monotonic() - t0

    rows, p2_mismatch = [], 0
    totals = dict(my_moves=0, deep_checked_by_pipeline=0)
    for g in sample:
        stored = store.load_analysis(g)
        full = deep[g["id"]]
        # The pipeline's own deep checks must come out identical in the full run.
        for k, v in stored["p2"].items():
            if full["p2"].get(k) != v:
                p2_mismatch += 1
        prod = {m["ply"]: m for m in derive_mistakes(g, stored, settings)}
        truth = {m["ply"]: m for m in derive_mistakes(g, full, settings)}
        me = g["my_color"]
        my_plies = [i for i in range(len(g["moves"].split())) if i % 2 == (0 if me == "white" else 1)]
        totals["my_moves"] += len(my_plies)
        totals["deep_checked_by_pipeline"] += len(stored["p2"])
        for ply in my_plies:
            t, p = truth.get(ply), prod.get(ply)
            if not t and not p:
                continue
            p1_before = win_pct(stored["p1"][ply][0], me)
            p1_after = win_pct(stored["p1"][ply + 1][0], me)
            mv = g["moves"].split()[ply]
            p1_drop = 0.0 if mv == stored["p1"][ply][1] else p1_before - p1_after
            if str(ply) in stored["p2"]:
                why = "deep-checked"
            elif p1_before < e["candidate_min_win_before"]:
                why = "pass1_already_lost"
            else:
                why = "pass1_drop_below_threshold"
            rows.append({
                "game_id": g["id"], "url": g["url"], "time_class": g["time_class"], "ply": ply,
                "move": mv, "screen": why, "pass1_drop": round(p1_drop, 1),
                "pipeline_label": p["label"] if p else None,
                "deep_label": t["label"] if t else None,
                "deep_drop": t["drop"] if t else None,
                "deep_card": bool(t) and not t["excluded_by"],
                "pipeline_card": bool(p) and not p["excluded_by"],
                "deep_excluded_by": t["excluded_by"] if t else None,
                "fen_before": (t or p)["fen_before"],
                "deep_best_line": t["best_line"] if t else None,
                "deep_score_before": t["score_before"] if t else None,
                "deep_score_after": t["score_after"] if t else None,
            })

    def count(pred):
        return sum(1 for r in rows if pred(r))

    mistake = LABEL_RANK["mistake"]
    summary = {
        "platform": f"{platform.system()} {platform.machine()}",
        "cpu": cpu_model(),
        "workers": args.workers,
        "engine": e,
        "games": len(sample),
        "games_by_bucket": {f"{s}/{tc}": sum(1 for g in sample if (g["site"], g["time_class"]) == (s, tc))
                            for s, tc in sorted({(g["site"], g["time_class"]) for g in sample})},
        "my_moves": totals["my_moves"],
        "deep_checked_by_pipeline": totals["deep_checked_by_pipeline"],
        "pipeline_deep_checks_reproduced_identically": totals["deep_checked_by_pipeline"] - p2_mismatch,
        "deep_mistakes_or_blunders": count(lambda r: rank(r["deep_label"]) >= mistake),
        "pipeline_mistakes_or_blunders": count(lambda r: rank(r["pipeline_label"]) >= mistake),
        "missed_mistakes_or_blunders": count(lambda r: rank(r["deep_label"]) >= mistake and rank(r["pipeline_label"]) < mistake),
        "missed_by_reason": {
            reason: count(lambda r, reason=reason: r["screen"] == reason and rank(r["deep_label"]) >= mistake
                          and rank(r["pipeline_label"]) < mistake)
            for reason in ("pass1_drop_below_threshold", "pass1_already_lost", "deep-checked")},
        "missed_blunders": count(lambda r: r["deep_label"] == "blunder" and rank(r["pipeline_label"]) < mistake),
        "deep_cards": count(lambda r: r["deep_card"]),
        "pipeline_cards": count(lambda r: r["pipeline_card"]),
        "missed_cards": count(lambda r: r["deep_card"] and not r["pipeline_card"]),
        "pipeline_cards_not_confirmed": count(lambda r: r["pipeline_card"] and not r["deep_card"]),
        "missed_inaccuracies": count(lambda r: r["deep_label"] == "inaccuracy" and r["pipeline_label"] is None),
        "pipeline_inaccuracies_not_confirmed": count(lambda r: r["pipeline_label"] == "inaccuracy" and r["deep_label"] is None),
        "wall_s": round(wall, 1),
        "engine_s": round(sum(d["secs"] for d in deep.values()), 1),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps({**summary, "rows": rows}, indent=1))
    print(json.dumps(summary, indent=1))
    sys.exit(0 if p2_mismatch == 0 else 1)


if __name__ == "__main__":
    main()
