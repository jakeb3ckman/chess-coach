"""Print the opening-report tables for docs/phase-3-plan.md from stored data.

    uv run python scripts/phase3_numbers.py [--engine N]   (N = positions to test-search)

Repertoire, opponents' replies and opening leaks use only stored games and
stored Stockfish output. --engine runs the proposed position pass (MultiPV 5,
5M nodes, 1 thread, hash cleared) on the worst leaks and most common positions,
to show what the new pass returns; it writes nothing into data/.
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from coach.classify import win_pct  # noqa: E402
from coach.openings import family, my_move_drop, name_game, opening_table, variation  # noqa: E402
from coach.store import Store  # noqa: E402

LEAK_MAX_PLY = 30        # my first 15 moves
LEAK_MIN_REACHED = 3     # position reached in at least 3 games
LEAK_MIN_PLAYED = 2      # the move played there at least twice
LEAK_MIN_DROP = 5.0      # loses at least 5 Win% (Lichess's inaccuracy line)
GROUP_MIN = 10           # a variation needs 10 games to be its own row
REPLY_MAX_PLY = 8
REPLY_MIN_REACHED = 20
SCORE = {"win": 1.0, "draw": 0.5, "loss": 0.0}


def san_path(moves: list[str], upto: int) -> str:
    b = chess.Board()
    out = []
    for i, mv in enumerate(moves[:upto]):
        m = chess.Move.from_uci(mv)
        s = b.san(m)
        out.append(f"{i // 2 + 1}.{s}" if i % 2 == 0 else (f"{i // 2 + 1}...{s}" if not out else s))
        b.push(m)
    return " ".join(out)


def wdl(rs: list[str]) -> str:
    c = Counter(rs)
    n = len(rs)
    return f"{c['win']}–{c['draw']}–{c['loss']} | {100 * sum(SCORE[r] for r in rs) / n:.0f}%"


def link(g: dict, ply: int) -> str:
    if g["site"] == "lichess":
        return f"{g['url']}/{g['my_color']}#{ply}"
    return g["url"]


def main(engine_n: int = 0):
    st = Store()
    games = []
    for g in st.iter_games():
        with open(st.analysis_path(g)) as f:
            g["_a"] = json.load(f)
        g["_m"] = g["moves"].split()
        g["_name"] = name_game(g["_m"])
        games.append(g)

    # ------------------------------------------------ repertoire
    print("## Repertoire\n")
    for color in ("white", "black"):
        gs = [g for g in games if g["my_color"] == color]
        vcount = Counter(variation(g["_name"][1]) for g in gs)
        def group(g):
            v = variation(g["_name"][1])
            return v if vcount[v] >= GROUP_MIN else f"{family(g['_name'][1])} (other lines)"
        groups = defaultdict(list)
        for g in gs:
            groups[group(g)].append(g)
        rows = sorted(groups.items(), key=lambda kv: -len(kv[1]))
        big = [r for r in rows if len(r[1]) >= GROUP_MIN]
        print(f"### As {color}: {len(gs)} games, {len(rows)} groups, {len(big)} with ≥{GROUP_MIN} games "
              f"covering {sum(len(r[1]) for r in big)} games\n")
        print("| # | Opening | Games | W–D–L | Score | Bullet | Blitz | Rapid |")
        print("|---|---|---|---|---|---|---|---|")
        for k, (name, gg) in enumerate(rows[:10], 1):
            cells = []
            for tc in ("bullet", "blitz", "rapid"):
                rs = [g["my_result"] for g in gg if g["time_class"] == tc]
                cells.append(f"{len(rs)} · {100 * sum(SCORE[r] for r in rs) / len(rs):.0f}%" if rs else "–")
            print(f"| {k} | {name} | {len(gg)} | {wdl([g['my_result'] for g in gg])} | " + " | ".join(cells) + " |")
        print()

    # ------------------------------------------------ opponents' replies
    reached = defaultdict(list)     # (color, epd) -> [(game, ply)]
    for g in games:
        b = chess.Board()
        par = 1 if g["my_color"] == "white" else 0  # opponent's plies
        for i, mv in enumerate(g["_m"][:REPLY_MAX_PLY]):
            if i % 2 == par:
                reached[(g["my_color"], b.epd())].append((g, i))
            b.push_uci(mv)
    rows = []
    for (color, epd), occ in reached.items():
        if len(occ) < REPLY_MIN_REACHED:
            continue
        by = defaultdict(list)
        for g, i in occ:
            by[g["_m"][i]].append((g, i))
        for mv, oo in by.items():
            rows.append((len(oo), color, len(occ), oo))
    rows.sort(key=lambda r: -r[0])
    print(f"## Opponents' replies (positions with the opponent to move in plies 1–{REPLY_MAX_PLY}, reached ≥{REPLY_MIN_REACHED} times)\n")
    print("| # | I play | After | Their reply | Games | Share of that position | My W–D–L after it | Score |")
    print("|---|---|---|---|---|---|---|---|")
    for k, (n, color, tot, oo) in enumerate(rows[:10], 1):
        g, i = oo[0]
        before = san_path(g["_m"], i) or "(start)"
        reply = san_path(g["_m"], i + 1).split()[-1]
        res = wdl([x[0]["my_result"] for x in oo]).split(" | ")
        print(f"| {k} | {color} | {before} | **{reply}** | {n} | {100 * n / tot:.0f}% of {tot} | {res[0]} | {res[1]} |")
    print()

    # ------------------------------------------------ leaks
    pos = defaultdict(list)  # epd -> [(game, ply, move, drop, src, wb, best)]
    for g in games:
        a = g["_a"]
        me = g["my_color"]
        par = 0 if me == "white" else 1
        b = chess.Board()
        for i, mv in enumerate(g["_m"][:LEAK_MAX_PLY]):
            if i % 2 == par:
                drop, src = my_move_drop(i, mv, me, a["p1"], a.get("p2", {}))
                deep = a.get("p2", {}).get(str(i))
                best_score = deep["lines"][0][0] if deep and deep["lines"] else a["p1"][i][0]
                best = deep["lines"][0][2].split()[0] if deep and deep["lines"] else a["p1"][i][1]
                pos[b.epd()].append((g, i, mv, drop, src, win_pct(best_score, me), best))
            b.push_uci(mv)
    repeated = {k: v for k, v in pos.items() if len(v) >= LEAK_MIN_REACHED}
    leaks = []
    for epd, occ in repeated.items():
        by = defaultdict(list)
        for o in occ:
            by[o[2]].append(o)
        for mv, oo in by.items():
            if len(oo) < LEAK_MIN_PLAYED:
                continue
            o = max(oo, key=lambda x: x[4])  # deep pass where stored
            if o[3] < LEAK_MIN_DROP or not (10 <= o[5] <= 90):
                continue
            leaks.append({"epd": epd, "move": mv, "played": len(oo), "reached": len(occ), "drop": o[3],
                          "src": o[4], "best": o[6], "wb": o[5], "occ": oo, "total": o[3] * len(oo)})
    leaks.sort(key=lambda r: -r["total"])
    print(f"## Opening leaks\n\nRepeated positions (me to move, first 15 moves, ≥{LEAK_MIN_REACHED} games): "
          f"{len(repeated)}. Leaks: {len(leaks)} (in {len({l['epd'] for l in leaks})} positions), "
          f"played {sum(l['played'] for l in leaks)} times, "
          f"{sum(l['src'] == 2 for l in leaks)} measured by the deep pass, {sum(l['src'] == 1 for l in leaks)} by pass 1 only.\n")
    by_band = Counter("15+" if l["drop"] >= 15 else "10–15" if l["drop"] >= 10 else "7–10" if l["drop"] >= 7 else "5–7" for l in leaks)
    print("Drop bands:", dict(by_band), "\n")
    for k, l in enumerate(leaks[:15], 1):
        g, i = l["occ"][0][0], l["occ"][0][1]
        b = chess.Board()
        for mv in g["_m"][:i]:
            b.push_uci(mv)
        fen = b.fen()
        name = name_game(g["_m"][:i])
        rs = [o[0]["my_result"] for o in l["occ"]]
        recent = sorted(l["occ"], key=lambda o: o[0]["ended_at"], reverse=True)[:3]
        print(f"**{k}. {san_path(g['_m'], i)} …** ({name[1] if name else 'start'})")
        print(f"- FEN `{fen}` · as {g['my_color']} · reached in {l['reached']} games")
        print(f"- My move **{b.san(chess.Move.from_uci(l['move']))}**: played {l['played']}× (results {wdl(rs)}) · "
              f"engine's move **{b.san(chess.Move.from_uci(l['best']))}** · loses {l['drop']:.1f} Win% "
              f"(pass {l['src']}; Win% before {l['wb']:.0f}) · total {l['total']:.0f}")
        print("- Games: " + " · ".join(link(o[0], o[1]) for o in recent))
        print()

    if engine_n:
        run_engine(leaks[:engine_n], repeated)


def run_engine(leaks, repeated):
    import time
    import chess.engine
    from coach.engine import engine_path
    eng = chess.engine.SimpleEngine.popen_uci(str(engine_path()))
    eng.configure({"Threads": 1, "Hash": 16})
    common = sorted(repeated.items(), key=lambda kv: -len(kv[1]))[:10]
    todo = [(l["epd"], l["occ"][0]) for l in leaks] + [(epd, occ[0]) for epd, occ in common]
    seen = set()
    print("## Test run of the proposed position pass (MultiPV 5, 5M nodes)\n")
    t0 = time.time()
    for epd, (g, i, *_rest) in todo:
        if epd in seen:
            continue
        seen.add(epd)
        b = chess.Board()
        for mv in g["_m"][:i]:
            b.push_uci(mv)
        me = g["my_color"]
        eng.protocol.send_line("ucinewgame")
        infos = eng.analyse(b, chess.engine.Limit(nodes=5_000_000), multipv=5)
        lines = []
        for inf in infos:
            sc = inf["score"].white()
            cp = sc.score(mate_score=100000)
            sc_str = cp if not sc.is_mate() else f"M{'+' if sc.mate() > 0 else '-'}{abs(sc.mate())}"
            lines.append((inf["pv"][0], sc_str, win_pct(sc_str, me)))
        best_w = lines[0][2]
        played = Counter(o[2] for o in repeated[epd])
        cells = ", ".join(f"{b.san(m)} −{best_w - w:.1f}" if best_w - w > 0.05 else f"{b.san(m)} best"
                          for m, _, w in lines)
        fine = [b.san(m) for m, _, w in lines if best_w - w <= 2.0]
        mine = ", ".join(f"{b.san(chess.Move.from_uci(m))}×{n}" for m, n in played.most_common(4))
        print(f"- `{b.fen()}` ({len(repeated[epd])} games). Top 5 (Win% behind best): {cells}. "
              f"Within 2 Win%: {', '.join(fine)}{' (complete)' if len(fine) < 5 else ' (may be incomplete)'}. I played: {mine}")
    print(f"\n{len(seen)} positions in {time.time() - t0:.0f} s")
    eng.quit()


if __name__ == "__main__":
    n = int(sys.argv[sys.argv.index("--engine") + 1]) if "--engine" in sys.argv else 0
    main(n)
