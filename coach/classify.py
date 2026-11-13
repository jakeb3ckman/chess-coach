"""Mistake classification and card eligibility. Pure functions, no engine.

Scores are stored as engine output from White's point of view:
  int            centipawns
  "M+3" / "M-3"  mate in 3 for White / for Black
  "M+0" / "M-0"  White / Black has already delivered mate (game over)

Win% formula and thresholds follow Lichess:
  scalachess core/src/main/scala/eval.scala  (WinPercent, Cp.CEILING = 1000)
  lila modules/tree/src/main/Advice.scala    (0.1 / 0.2 / 0.3 winning chances
                                              = 5 / 10 / 15 Win% points)
"""
from __future__ import annotations

import math

CP_CEILING = 1000
MULTIPLIER = -0.00368208


def score_to_cp(score) -> int:
    """White-view score -> centipawns, mates mapped to +-1000 like Lichess."""
    if isinstance(score, int):
        return score
    if isinstance(score, str) and score.startswith("M"):
        return CP_CEILING if score[1] == "+" else -CP_CEILING
    raise ValueError(f"bad score {score!r}")


def win_pct_white(score) -> float:
    cp = max(-CP_CEILING, min(CP_CEILING, score_to_cp(score)))
    return 50 + 50 * (2 / (1 + math.exp(MULTIPLIER * cp)) - 1)


def win_pct(score, color: str) -> float:
    """Win% (0-100) for `color` ('white'/'black')."""
    w = win_pct_white(score)
    return w if color == "white" else 100 - w


def label(drop: float, labels: dict) -> str | None:
    if drop >= labels["blunder"]:
        return "blunder"
    if drop >= labels["mistake"]:
        return "mistake"
    if drop >= labels["inaccuracy"]:
        return "inaccuracy"
    return None


LABEL_RANK = {"inaccuracy": 1, "mistake": 2, "blunder": 3}


def time_trouble_threshold(base_s: float, cards: dict) -> float:
    return min(cards["time_trouble_max_s"], cards["time_trouble_frac"] * base_s)


def card_exclusions(m: dict, cards: dict) -> list[str]:
    """Return every rule this mistake fails (empty list = eligible).

    m needs: label, source_pass, win_before, win_after, second_best_gap (or None
    when only one legal move), clock_before_s (or None), base_s.
    """
    reasons = []
    if m["source_pass"] != 2:
        reasons.append("no_deep_check")
    if m["label"] is None or LABEL_RANK.get(m["label"], 0) < LABEL_RANK[cards["min_label"]]:
        reasons.append("below_min_label")
    gap = m.get("second_best_gap")
    if m["source_pass"] == 2 and gap is not None and gap < cards["min_second_best_gap"]:
        reasons.append("best_not_clearly_best")
    wb, wa = m["win_before"], m["win_after"]
    if wb < cards["decided_low"]:
        reasons.append("already_lost")
    elif wb > cards["decided_high"] and wa >= cards["thrown_win_below"]:
        reasons.append("already_won")
    clk = m.get("clock_before_s")
    if clk is not None and clk < time_trouble_threshold(m["base_s"], cards):
        reasons.append("time_trouble")
    return reasons
