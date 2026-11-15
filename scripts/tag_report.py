"""Tag counts and 5 example cards per tag, for checking the tag rules by hand.

Usage (after `coach build`): uv run python scripts/tag_report.py > tmp/tag_report.md
Reads data/derived/cards.json and data/derived/mistakes.jsonl.
"""
from __future__ import annotations

import collections
import hashlib
import json
import sys
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from coach.build import game_link  # noqa: E402
from coach.config import ROOT  # noqa: E402
from coach.tags import TAG_ORDER, eval_text, hung_piece_loss  # noqa: E402


def san_line(fen: str, uci_line: str | None, first_move_number: bool = True) -> str:
    if not uci_line:
        return "(none)"
    b = chess.Board(fen)
    out = []
    for i, u in enumerate(uci_line.split()):
        mv = chess.Move.from_uci(u)
        if mv not in b.legal_moves:
            break
        prefix = f"{b.fullmove_number}." if b.turn == chess.WHITE else (f"{b.fullmove_number}..." if i == 0 else "")
        out.append(prefix + b.san(mv))
        b.push(mv)
    return " ".join(out)


def main():
    derived = ROOT / "data" / "derived"
    cards = json.loads((derived / "cards.json").read_text())
    mistakes = [json.loads(line) for line in (derived / "mistakes.jsonl").open()]
    deep = [m for m in mistakes if m["source_pass"] == 2]
    with_ref = [m for m in deep if m["refutation_line"] is not None]
    mismatch = [m for m in with_ref if not m["refutation_matches"]]
    p = print
    p(f"Cards: {len(cards)}. Deep-checked moves: {len(deep)}; with a refutation line: {len(with_ref)}; "
      f"refutation score differs from the stored 'after' score: {len(mismatch)}.\n")
    counts = collections.Counter(t for c in cards for t in c["tags"])
    p("| tag | cards | share |\n|---|---|---|")
    for t in TAG_ORDER:
        p(f"| {t} | {counts[t]} | {100 * counts[t] / len(cards):.1f}% |")
    untagged = sum(1 for c in cards if not c["tags"])
    p(f"| (no tag) | {untagged} | {100 * untagged / len(cards):.1f}% |\n")

    # Examples: the latest occurrence that carries the tag, picked deterministically.
    by_key = {(m["game_id"], m["ply"]): m for m in mistakes}
    for t in TAG_ORDER:
        tagged = [c for c in cards if t in c["tags"]]
        tagged.sort(key=lambda c: hashlib.sha1(f"tags|{t}|{c['card_id']}".encode()).hexdigest())
        p(f"### {t} ({counts[t]} cards)\n")
        for c in tagged[:5]:
            occ = next(o for o in c["occurrences"] if t in by_key[(o["game_id"], o["ply"])]["tags"])
            m = by_key[(occ["game_id"], occ["ply"])]
            b = chess.Board(m["fen_before"])
            after = b.copy()
            after.push_uci(m["my_move"])
            p(f"- **{c['card_id']}** · {m['time_class']} · {m['ended_at'][:10]} · I played {m['my_color']}, move {m['move_number']}")
            p(f"  - FEN: `{m['fen_before']}`")
            p(f"  - Game: {game_link(occ, m['my_color'])} · board: https://lichess.org/analysis/standard/{m['fen_before'].replace(' ', '_')}")
            p(f"  - Best: {san_line(m['fen_before'], m['best_line'])} ({eval_text(m['score_before'], m['my_color'])}) · "
              f"I played: {b.san(chess.Move.from_uci(m['my_move']))} ({eval_text(m['score_after'], m['my_color'])}) · "
              f"refutation: {san_line(after.fen(), m['refutation_line'])}")
            extra = f"Win% {m['win_before']} → {m['win_after']}"
            if t == "hung piece":
                extra += f" · material lost in the capture sequence: {hung_piece_loss(m)}"
            p(f"  - {extra}")
        p("")


if __name__ == "__main__":
    main()
