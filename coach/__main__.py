"""Command line: python -m coach {import,analyze,build,versions}."""
from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
from importlib import metadata

from .build import build_all
from .config import load_settings
from .engine import engine_path
from .http import HttpClient
from .importers import import_chesscom, import_lichess
from .runner import pending_games, run_analysis
from .store import Store


def versions() -> dict:
    out = subprocess.run([str(engine_path())], input="uci\nquit\n", capture_output=True, text=True).stdout
    sf = next((l[len("id name "):] for l in out.splitlines() if l.startswith("id name ")), "not found")
    return {
        "stockfish": sf,
        "python": platform.python_version(),
        "chess (python-chess)": metadata.version("chess"),
        "pytest": metadata.version("pytest") if _has("pytest") else "not installed",
        "platform": f"{platform.system()} {platform.machine()}",
    }


def _has(pkg):
    try:
        metadata.version(pkg)
        return True
    except metadata.PackageNotFoundError:
        return False


def main(argv=None):
    p = argparse.ArgumentParser(prog="coach")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("import", help="fetch new games from both sites")
    a = sub.add_parser("analyze", help="run Stockfish on games without analysis")
    a.add_argument("--shard", default="0/1", help="i/N, e.g. 2/4")
    a.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    a.add_argument("--budget-minutes", type=float)
    a.add_argument("--limit", type=int)
    a.add_argument("--commit", action="store_true", help="git commit + push after every batch")
    a.add_argument("--no-push", action="store_true")
    b = sub.add_parser("build", help="derive mistakes and cards")
    b.add_argument("--app-out", help="also write the app's card file here")
    sub.add_parser("pending", help="print how many games still need analysis")
    sub.add_parser("versions", help="print installed versions")
    args = p.parse_args(argv)

    settings = load_settings()
    store = Store()
    if args.cmd == "import":
        client = HttpClient(settings["import"]["user_agent"])
        res = {"chesscom": import_chesscom(client, store, settings).as_dict(),
               "lichess": import_lichess(client, store, settings).as_dict()}
        print(json.dumps(res, indent=1))
    elif args.cmd == "analyze":
        i, n = (int(x) for x in args.shard.split("/"))
        budget = args.budget_minutes * 60 if args.budget_minutes is not None else None
        res = run_analysis(store, settings, shard=i, shards=n, workers=args.workers, budget_s=budget,
                           limit=args.limit, commit=args.commit, push=not args.no_push)
        print(json.dumps(res, indent=1))
        if res["failed"]:
            sys.exit(1)
    elif args.cmd == "build":
        print(json.dumps(build_all(store, settings, app_out=args.app_out), indent=1))
    elif args.cmd == "pending":
        print(len(pending_games(store)))
    elif args.cmd == "versions":
        print(json.dumps(versions(), indent=1))


if __name__ == "__main__":
    main()
