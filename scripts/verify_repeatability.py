"""Re-analyze a sample of already-analyzed games and compare with the stored results.

Used on a GitHub runner to check that it produces exactly the same Stockfish
output as the Mac that ran the backfill.

Usage: uv run python scripts/verify_repeatability.py --sample 30 --out tmp/repeatability.json
Exit code 0 = every compared game identical.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from coach.config import load_settings  # noqa: E402
from coach.runner import run_analysis  # noqa: E402
from coach.store import Store  # noqa: E402


def pick_sample(store: Store, n: int) -> list[dict]:
    """Deterministic, spread over site x time control."""
    done = [g for g in store.iter_games() if store.has_analysis(g)]
    buckets: dict[tuple, list] = {}
    for g in done:
        buckets.setdefault((g["site"], g["time_class"]), []).append(g)
    for b in buckets.values():
        b.sort(key=lambda g: hashlib.sha1(g["id"].encode()).hexdigest())
    out, i = [], 0
    while len(out) < n and any(i < len(b) for b in buckets.values()):
        for key in sorted(buckets):
            if i < len(buckets[key]) and len(out) < n:
                out.append(buckets[key][i])
        i += 1
    return out


def cpu_model() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=30)
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--out", default="tmp/repeatability.json")
    args = ap.parse_args()
    settings = load_settings()
    src = Store()
    sample = pick_sample(src, args.sample)
    with tempfile.TemporaryDirectory() as tmp:
        scratch = Store(Path(tmp) / "data")
        for g in sample:
            scratch.add_game(g)
        import os
        res = run_analysis(scratch, settings, workers=args.workers or os.cpu_count() or 1, log=lambda *_: None)
        rows = []
        for g in sample:
            mine, theirs = scratch.load_analysis(g), src.load_analysis(g)
            same = mine is not None and (mine["p1"], mine["pv1"], mine["p2"]) == (theirs["p1"], theirs["pv1"], theirs["p2"])
            diff_positions = None
            if mine is not None and not same:
                diff_positions = sum(a != b for a, b in zip(mine["p1"], theirs["p1"]))
            rows.append({"id": g["id"], "time_class": g["time_class"], "identical": same,
                         "p1_positions": len(theirs["p1"]), "p2_checks": len(theirs["p2"]),
                         "p1_positions_different": diff_positions,
                         "runner_secs": mine["secs"] if mine else None, "stored_secs": theirs["secs"]})
    report = {
        "platform": f"{platform.system()} {platform.machine()}",
        "cpu": cpu_model(),
        "workers": args.workers or os.cpu_count(),
        "engine": settings["engine"],
        "games": len(rows),
        "identical": sum(r["identical"] for r in rows),
        "positions_compared": sum(r["p1_positions"] for r in rows),
        "deep_checks_compared": sum(r["p2_checks"] for r in rows),
        "run": res,
        "rows": rows,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k != "rows"}, indent=1))
    sys.exit(0 if report["identical"] == report["games"] else 1)


if __name__ == "__main__":
    main()
