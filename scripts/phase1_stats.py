"""Compute every number in docs/phase-1-report.md from stored data.

Usage: uv run python scripts/phase1_stats.py > tmp/phase1_stats.md
Reads data/games, data/analysis and data/derived (run `python -m coach build` first).
All evaluations shown come from the stored Stockfish output.
"""
from __future__ import annotations

import collections
import hashlib
import json
import statistics
import subprocess
import sys
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from coach.classify import time_trouble_threshold  # noqa: E402
from coach.config import load_settings  # noqa: E402
from coach.store import Store  # noqa: E402

TCS = ["bullet", "blitz", "rapid"]
LABELS = ["inaccuracy", "mistake", "blunder"]


def table(header, rows):
    out = ["", "| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def fmt_score(score, color):
    """Engine score from my side's view, in pawns or mate."""
    if isinstance(score, str):
        n = int(score[2:])
        mine = (score[1] == "+") == (color == "white")
        return f"mate in {n} for me" if mine else f"mate in {n} against me"
    v = score if color == "white" else -score
    return f"{v / 100:+.2f}"


def san_line(fen, uci_line, max_plies=8):
    b = chess.Board(fen)
    out = []
    for u in uci_line.split()[:max_plies]:
        mv = chess.Move.from_uci(u)
        prefix = f"{b.fullmove_number}." if b.turn == chess.WHITE else (f"{b.fullmove_number}..." if not out else "")
        out.append(prefix + b.san(mv))
        b.push(mv)
    return " ".join(out)


def game_link(m):
    if m["site"] == "lichess":
        return f"{m['url']}/{m['my_color']}#{m['ply']}"
    return m["url"]


def main():
    settings = load_settings()
    store = Store()
    games = list(store.iter_games())
    analyses = {g["id"]: store.load_analysis(g) for g in games}
    mistakes = [json.loads(l) for l in open(store.derived / "mistakes.jsonl")]
    cards = json.loads((store.derived / "cards.json").read_text())
    p = print

    # 1. games imported
    p("## Games imported\n")
    c = collections.Counter((g["site"], g["time_class"]) for g in games)
    rows = [[s] + [c[(s, t)] for t in TCS] + [sum(c[(s, t)] for t in TCS)] for s in ("chesscom", "lichess")]
    rows.append(["**total**"] + [sum(c[(s, t)] for s in ("chesscom", "lichess")) for t in TCS] + [len(games)])
    p(table(["site", *TCS, "total"], rows))
    rated = collections.Counter(g["rated"] for g in games)
    clocks_ok = sum(1 for g in games if g["clocks"] and all(x is not None for x in g["clocks"]))
    p(f"\nRated: {rated[True]}, casual: {rated[False]}. Games with a clock on every move: {clocks_ok}/{len(games)}.")
    months = collections.Counter(g["ended_at"][:7] for g in games)
    p("\nGames per month (end date): " + ", ".join(f"{k}: {v}" for k, v in sorted(months.items())))

    # 2. analysis coverage + speed
    done = [a for a in analyses.values() if a]
    failed = list((store.data / "analysis-failed").glob("*/*/*.json"))
    p("\n## Analysis coverage and speed\n")
    # The first 20 games were analyzed by an early runner version that slowed itself
    # down (see report); their results are identical but their timings are not representative.
    slow_ids = set()
    ids_file = Path("tmp/first_run_ids.txt")
    if ids_file.exists():
        slow_ids = set(ids_file.read_text().split())
    # Which machine produced each analysis file: commits by the GitHub Actions bot came
    # from a runner, everything else from the Mac.
    bot_files = set(subprocess.run(
        ["git", "log", "--author=github-actions", "--diff-filter=A", "--name-only", "--format=", "--", "data/analysis"],
        capture_output=True, text=True, check=True).stdout.split())
    by_machine: dict[str, list[float]] = {"GitHub runner": [], "Mac": []}
    for g in games:
        a = analyses[g["id"]]
        if not a or g["site_id"] in slow_ids:
            continue
        rel = str(store.analysis_path(g).relative_to(store.data.parent))
        by_machine["GitHub runner" if rel in bot_files else "Mac"].append(a["secs"])
    p(f"Speed stats below exclude {len(slow_ids)} games timed by the first, slowed-down Mac run.")
    positions = sum(len(a["p1"]) for a in done)
    p2 = sum(len(a["p2"]) for a in done)
    p(f"Analyzed: {len(done)}/{len(games)} games; failed: {len(failed)}.")
    p(f"Positions in pass 1: {positions:,}; pass-2 deep checks: {p2:,} ({p2 / max(1, len(done)):.1f} per game).")
    p("\n| machine | games | engine s per game, mean | median | thread-hours |\n|---|---|---|---|---|")
    for name, secs in by_machine.items():
        if secs:
            p(f"| {name} | {len(secs)} | {statistics.mean(secs):.1f} | {statistics.median(secs):.1f} | {sum(secs) / 3600:.1f} |")
    p("\n(Mac: Apple M3 Pro, 9-10 engines in parallel. Runner: 4 engines in parallel, one per vCPU. "
      "Each engine uses one thread.)\n")
    engines = collections.Counter(json.dumps(a["engine"], sort_keys=True) for a in done)
    p(f"Engine settings used (distinct): {len(engines)} -> {list(engines)[0] if engines else '-'}")

    # 3. mistakes by label x time control
    p("\n## Mistakes found (all of my moves that lost at least 5 Win%)\n")
    c = collections.Counter((m["label"], m["time_class"]) for m in mistakes)
    rows = [[lab] + [c[(lab, t)] for t in TCS] + [sum(c[(lab, t)] for t in TCS)] for lab in LABELS]
    rows.append(["**total**"] + [sum(c[(lab, t)] for lab in LABELS) for t in TCS] + [len(mistakes)])
    p(table(["label", *TCS, "total"], rows))
    my_moves = collections.Counter()
    for g in games:
        if analyses[g["id"]]:
            n = len(g["moves"].split())
            my_moves[g["time_class"]] += (n + (g["my_color"] == "white")) // 2
    p("\nPer 100 of my moves: " + ", ".join(
        f"{t} {100 * sum(c[(lab, t)] for lab in LABELS) / max(1, my_moves[t]):.1f}" for t in TCS))
    srcs = collections.Counter((m["label"], m["source_pass"]) for m in mistakes)
    p("\nLabel source: " + ", ".join(f"{lab}: deep {srcs[(lab, 2)]} / pass-1 only {srcs[(lab, 1)]}" for lab in LABELS))

    # 4. card funnel
    p("\n## From mistakes to cards\n")
    big = [m for m in mistakes if m["label"] in ("mistake", "blunder")]
    p(f"Mistakes + blunders: {len(big)}")
    reasons = collections.Counter(r for m in big for r in m["excluded_by"])
    only = collections.Counter(m["excluded_by"][0] for m in big if len(m["excluded_by"]) == 1)
    names = {
        "no_deep_check": "no deep check (pass 1 skipped it: I was already below 5 Win%)",
        "best_not_clearly_best": "best move not clearly best (2nd best within 15 Win%)",
        "already_lost": "already lost (below 10 Win% before the move)",
        "already_won": "already won (above 90 before, still 50+ after)",
        "time_trouble": "severe time trouble",
    }
    rows = [[names.get(r, r), reasons[r], only[r]] for r in names]
    p(table(["rule", "mistakes failing it", "failing ONLY this rule"], rows))
    elig = [m for m in big if not m["excluded_by"]]
    p(f"\nEligible: {len(elig)} mistakes -> {len(cards)} cards after de-duplication "
      f"({len(elig) - len(cards)} repeats of a position already in the deck). "
      f"Cards seen more than once: {sum(1 for c in cards if c['n_occurrences'] > 1)}. "
      f"Cards whose occurrences disagree on the best move: {sum(1 for c in cards if c['solution_conflict'])}.")
    ce = collections.Counter(m["time_class"] for m in elig)
    p("Eligible by time control: " + ", ".join(f"{t} {ce[t]}" for t in TCS))
    tt = collections.Counter(m["time_class"] for m in big if "time_trouble" in m["excluded_by"])
    p("Excluded for time trouble, by time control: " + ", ".join(f"{t} {tt[t]}" for t in TCS))

    # 5. "don't hang the piece" positions
    p("\n## Positions dropped only because several moves were fine\n")
    hang = [m for m in big if m["excluded_by"] == ["best_not_clearly_best"]]
    hc = collections.Counter((m["time_class"], m["label"]) for m in hang)
    p(f"{len(hang)} mistakes/blunders pass every rule except 'best move clearly best'.")
    p(table(["time control", "mistake", "blunder"], [[t, hc[(t, 'mistake')], hc[(t, 'blunder')]] for t in TCS]))
    bins = collections.Counter(min(int(m["second_best_gap"] // 5) * 5, 10) for m in hang if m["second_best_gap"] is not None)
    p("\nGap between best and 2nd-best move (Win% points): " + ", ".join(
        f"{k}-{k + 5}: {bins[k]}" for k in (0, 5, 10)))
    wa = sum(1 for m in hang if m["win_after"] < 50 <= m["win_before"])
    p(f"Of these, {wa} turned a position where I was at least even into one where I was worse.")

    # 6. samples
    p("\n## Sample candidate puzzles\n")
    picks = pick_samples(cards, mistakes, settings)
    for n, (why, m, card) in enumerate(picks, 1):
        thr = time_trouble_threshold(m["base_s"], settings["cards"])
        p(f"### {n}. {m['time_class']} {m['base_s'] // 60 if m['base_s'] >= 60 else m['base_s']}"
          f"{'+' + str(m['inc_s']) if m['inc_s'] else '+0'} · {m['label']} · {why}\n")
        p(f"- Game: {game_link(m)} ({m['site']}, {m['ended_at'][:10]}, I played {m['my_color']}, move {m['move_number']})")
        p(f"- FEN: `{m['fen_before']}`")
        p(f"- View position: https://lichess.org/analysis/standard/{m['fen_before'].replace(' ', '_')}")
        b = chess.Board(m["fen_before"])
        p(f"- My move: **{b.san(chess.Move.from_uci(m['my_move']))}**")
        p(f"- Engine best line: **{san_line(m['fen_before'], m['best_line'])}**")
        p(f"- Eval before (best play): {fmt_score(m['score_before'], m['my_color'])} = {m['win_before']} Win%; "
          f"after my move: {fmt_score(m['score_after'], m['my_color'])} = {m['win_after']} Win%; "
          f"drop {m['drop']}")
        p(f"- Best vs 2nd-best gap: {m['second_best_gap'] if m['second_best_gap'] is not None else 'only one legal move'} Win%; "
          f"clock before move: {m['clock_before_s']} s (time-trouble line {thr:g} s); time spent: {m['time_spent_s']} s")
        if card["n_occurrences"] > 1:
            p(f"- Same position in {card['n_occurrences']} games: " + ", ".join(o["url"] for o in card["occurrences"]))
        p("")


def pick_samples(cards, mistakes, settings):
    """15 cards: 2 per (time control x label), then specials. Deterministic."""
    by_key = {}
    for m in mistakes:
        by_key[(m["game_id"], m["ply"])] = m
    entries = []
    for c in cards:
        o = c["occurrences"][0]
        m = by_key[(o["game_id"], o["ply"])]
        entries.append((m, c))

    def h(m):
        return hashlib.sha1(f"{m['game_id']}{m['ply']}".encode()).hexdigest()

    chosen, used = [], set()

    def take(pred, why, k=1):
        pool = sorted((e for e in entries if pred(e[0], e[1]) and id(e[1]) not in used), key=lambda e: h(e[0]))
        for m, c in pool[:k]:
            used.add(id(c))
            chosen.append((why, m, c))

    take(lambda m, c: c["n_occurrences"] > 1, "same position missed in more than one game")
    take(lambda m, c: m["win_before"] > 90, "thrown-away win (allowed by the exception)")
    take(lambda m, c: m["site"] == "lichess" and m["label"] == "blunder", "Lichess game")
    take(lambda m, c: m["site"] == "lichess" and m["label"] == "mistake", "Lichess game")
    take(lambda m, c: m["second_best_gap"] is not None and m["second_best_gap"] < 18, "borderline: 2nd-best move close to the 15-point limit")
    take(lambda m, c: m["drop"] < 11, "borderline: drop just over the 10-point mistake line")
    take(lambda m, c: m["clock_before_s"] is not None and m["clock_before_s"] < 2 * time_trouble_threshold(m["base_s"], settings["cards"]),
         "low clock, just above the time-trouble line")
    take(lambda m, c: m["move_number"] <= 10, "opening phase (move 10 or earlier)")
    for t in TCS:
        for lab in ("mistake", "blunder"):
            have = sum(1 for _, m, _c in chosen if m["time_class"] == t and m["label"] == lab)
            if have < 1:
                take(lambda m, c, t=t, lab=lab: m["time_class"] == t and m["label"] == lab, f"{t} {lab}")
    while len(chosen) < 15:
        before = len(chosen)
        for t in TCS:
            if len(chosen) < 15:
                take(lambda m, c, t=t: m["time_class"] == t, f"{t} (spread)")
        if len(chosen) == before:
            break
    return chosen[:15]


if __name__ == "__main__":
    main()
