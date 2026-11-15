# Phase 3 plan: opening report and insights page (STOP 1)

Date: 2026-11-15. Status: **for approval**. No app screens have been built.

**Data used:**
- all 3,233 games stored on 2026-11-15 (Chess.com and Lichess; bullet, blitz, rapid);
- their stored Stockfish 19 analysis: a pass-1 score and best move for every position (200k nodes), and deep results for my candidate moves (2M nodes);
- the refutation lines;
- `data/derived/mistakes.jsonl`;
- for the training lines only, the 46 review events in your private progress repository, read once and not stored anywhere.

**How to reproduce every number here:**
- opening tables: `uv run python scripts/phase3_numbers.py` (add `--engine 15` for the test search in A.4);
- insights: `coach/insights.py`.

**Same rules as before:**
- every evaluation, best move and mistake label comes from stored Stockfish output;
- opening names come from a public table;
- tips are fixed text, written once, chosen by a fixed rule, and shown apart from the numbers;
- nothing is AI-written.

## 0. Decisions I need from you

| # | Decision | My proposal |
|---|---|---|
| 1 | Opening grouping | Variation level when it has ≥10 games, else pooled under its family (A.1) |
| 2 | Leak rule | Position reached in ≥3 games in my first 15 moves; a move I played there ≥2 times that loses ≥5 Win%, measured by a new deep position search (A.4) |
| 3 | Extra engine work | One new write-once **position pass** for positions reached ≥3 times: about 1–2 hours on 4 parallel GitHub jobs once, then seconds per night (A.4) |
| 4 | Leak cards | A move counts as right when it is within **2 Win%** of the engine's best. At most **3 leak cards** among the 10 new cards a day (A.5) |
| 5 | Insights shown | 5 lines (B.2); 4 candidates checked and hidden for now, because the data shows no clear pattern; 1 dropped (speed); training waits for more reviews |
| 6 | Sample thresholds | ≥50 games, ≥500 moves or ≥30 events behind any number. A comparison is shown only when its 95% confidence interval excludes zero (B.1) |

---

## A. Opening report

### A.1 Naming and grouping openings

**Names.** Opening names come from Lichess's public CC0 opening table (`lichess-org/chess-openings`, 3,865 named lines). It is vendored in `config/chess-openings/` at commit `3ba6b20`.
- A game gets the name of the **last position within its first 40 half-moves that appears in the table**, matched by position, so transpositions get the same name. This is how Lichess names games.
- Both sites go through the same code.

**What the data shows:** your games leave named theory early. The median game gets its last name at half-move 3, and only 148 of 3,233 games are still in the table after half-move 6. As White there are 194 different variation names; as Black, 198.

**Grouping rule** (two levels, both exact):
- *family* = the name before the first ":", e.g. "Caro-Kann Defense";
- *variation* = the name before the first ",", e.g. "Caro-Kann Defense: Advance Variation";
- a variation with **≥10 games for that colour** is its own row; smaller ones are pooled as "Family (other lines)".

**Result:** 47 rows as White (covering 1,445 of 1,614 games) and 37 as Black (1,440 of 1,619). The rest sit in small pooled rows.

**On the screen:** one row per group with games, W–D–L, score, and filters for time control and colour. Tapping a row opens its move tree (A.4).

**Why not families only:** "Queen's Pawn Game" alone would merge your Chigorin (2.Nc3), London and Accelerated London games.

### A.2 Repertoire: top 10 per colour

Score = (wins + ½ draws) / games. The bullet, blitz and rapid columns show games · score.

#### As White: 1614 games, 89 groups, 47 with ≥10 games covering 1445 games

| # | Opening | Games | W–D–L | Score | Bullet | Blitz | Rapid |
|---|---|---|---|---|---|---|---|
| 1 | Queen's Pawn Game: Chigorin Variation | 183 | 94–4–85 | 52% | 116 · 52% | 48 · 51% | 19 · 61% |
| 2 | King's Pawn Game: Wayward Queen Attack | 105 | 50–0–55 | 48% | 67 · 49% | 27 · 44% | 11 · 45% |
| 3 | Queen's Pawn Game: Accelerated London System | 91 | 43–1–47 | 48% | 4 · 0% | 36 · 42% | 51 · 56% |
| 4 | Rapport-Jobava System | 84 | 47–2–35 | 57% | 60 · 59% | 18 · 53% | 6 · 50% |
| 5 | Zukertort Opening: Ross Gambit | 77 | 43–5–29 | 59% | 21 · 50% | 40 · 65% | 16 · 56% |
| 6 | Queen's Pawn Game: London System | 61 | 39–3–19 | 66% | 23 · 67% | 31 · 63% | 7 · 79% |
| 7 | Hungarian Opening | 58 | 24–2–32 | 43% | – | – | 58 · 43% |
| 8 | Horwitz Defense | 52 | 30–1–21 | 59% | 17 · 65% | 16 · 66% | 19 · 47% |
| 9 | Queen's Pawn Game | 47 | 27–1–19 | 59% | 25 · 72% | 10 · 30% | 12 · 54% |
| 10 | Scandinavian Defense | 44 | 10–2–32 | 25% | 30 · 25% | 10 · 20% | 4 · 38% |

#### As Black: 1619 games, 96 groups, 37 with ≥10 games covering 1440 games

| # | Opening | Games | W–D–L | Score | Bullet | Blitz | Rapid |
|---|---|---|---|---|---|---|---|
| 1 | Caro-Kann Defense | 291 | 128–6–157 | 45% | 153 · 46% | 88 · 38% | 50 · 54% |
| 2 | Modern Defense | 169 | 93–4–72 | 56% | 73 · 53% | 50 · 56% | 46 · 61% |
| 3 | Queen's Pawn Game: Modern Defense | 102 | 50–3–49 | 50% | 58 · 44% | 25 · 54% | 19 · 66% |
| 4 | Caro-Kann Defense: Hillbilly Attack | 89 | 57–1–31 | 65% | 47 · 70% | 23 · 52% | 19 · 66% |
| 5 | Pirc Defense | 74 | 35–2–37 | 49% | 3 · 67% | 23 · 39% | 48 · 52% |
| 6 | Caro-Kann Defense: Advance Variation | 54 | 22–1–31 | 42% | 32 · 45% | 15 · 33% | 7 · 43% |
| 7 | Van't Kruijs Opening | 53 | 24–0–29 | 45% | 23 · 48% | 19 · 37% | 11 · 55% |
| 8 | Caro-Kann Defense: Two Knights Attack | 50 | 23–3–24 | 49% | 24 · 54% | 14 · 39% | 12 · 50% |
| 9 | Caro-Kann Defense: Exchange Variation | 48 | 26–1–21 | 55% | 25 · 54% | 21 · 62% | 2 · 0% |
| 10 | Queen's Pawn Game | 43 | 27–0–16 | 63% | 6 · 67% | 19 · 68% | 18 · 56% |

**Notes** (facts from the table, not advice):
- As White, 1.d4 lines dominate: Chigorin, Accelerated London, London and Rapport-Jobava together are 419 games.
- The London rows score best: 66% over 61 games.
- The Scandinavian as White (1.e4 d5) scores 25% over 44 games.
- As Black, the Caro-Kann rows are 630 games, 39% of your Black games.

### A.3 What opponents play against me

**Definition:** a *reply* is the opponent's move in a position where they are to move, within the first 8 half-moves, in a position I reached ≥20 times. Ranked by number of games. "My W–D–L after it" counts the games in which they played that reply.

| # | I play | After | Their reply | Games | Share of that position | My W–D–L after it | Score |
|---|---|---|---|---|---|---|---|
| 1 | black | (start) | **1.e4** | 1039 | 64% of 1619 | 494–23–522 | 49% |
| 2 | black | (start) | **1.d4** | 322 | 20% of 1619 | 157–10–155 | 50% |
| 3 | white | 1.d4 | **d5** | 310 | 49% of 630 | 164–5–141 | 54% |
| 4 | white | 1.e4 | **e5** | 228 | 59% of 386 | 103–3–122 | 46% |
| 5 | black | 1.e4 c6 | **2.Nf3** | 165 | 26% of 624 | 72–4–89 | 45% |
| 6 | white | 1.Nf3 | **d5** | 159 | 34% of 470 | 86–2–71 | 55% |
| 7 | black | 1.e4 c6 | **2.d4** | 144 | 23% of 624 | 71–2–71 | 50% |
| 8 | white | 1.d4 | **e5** | 91 | 14% of 630 | 44–1–46 | 49% |
| 9 | black | 1.e4 c6 | **2.Bc4** | 89 | 14% of 624 | 57–1–31 | 65% |
| 10 | white | 1.Nf3 | **e5** | 84 | 18% of 470 | 47–6–31 | 60% |

**On the screen:** the same list, filtered by colour and time control. Tapping a reply opens the move tree from there.

### A.4 Opening leaks

The card rule ("best move at least 15 Win% better than the second best") found only 11 positions I had missed more than once. In the opening several moves are often fine, so leaks need their own rule.

**Proposed leak rule (exact):**
1. A position (pieces, side to move, castling rights, legal en passant) where **I am to move**, within my **first 15 moves**, reached in **≥3 of my games**.
2. A move I played there **≥2 times**.
3. That move loses **≥5 Win%** against the engine's best move: Lichess's inaccuracy line, "0.1 winning chances". Measured by the new position pass below, so every move is judged by the same search.
4. The game was not already decided: Win% before the move between 10 and 90, the same as the card rule.
5. **Ranking:** total Win% lost = Win% lost per time × times played. A cheap leak played 100 times outranks a big one played twice.

**Results with the data stored today** (deep pass where stored, else pass 1):
- 674 repeated positions;
- **198 leaks in 166 positions**, played 878 times in all;
- by Win% lost: 85 lose 5–7, 45 lose 7–10, 39 lose 10–15, 29 lose 15 or more;
- 75 of the 198 are measured by pass 1 only (200k nodes), so the 5–7 band will move when the position pass re-measures them. The test search below already shows this: for 1...Nc6 against 1.d4, pass 1 says −6.2, while the deeper search has five other moves within 1.5 Win% of the best.

**The 15 worst leaks** (ranked by total Win% lost; numbers from the stored analysis; one position can appear twice with two different moves):

**1. 1.e4 e5 …** (King's Pawn Game)
- FEN `rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2` · as white · reached in 227 games
- My move **Qh5**: played 105× (results 50–0–55 | 48%) · engine's move **Nf3** · loses 5.8 Win% (pass 1; Win% before 53) · total 608
- Games: https://www.chess.com/game/live/183968621912 · https://www.chess.com/game/live/174417205376 · https://www.chess.com/game/live/174411601952

**2. 1.d4 e5 …** (Englund Gambit)
- FEN `rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2` · as white · reached in 91 games
- My move **Nf3**: played 16× (results 7–0–9 | 44%) · engine's move **dxe5** · loses 15.4 Win% (pass 2; Win% before 63) · total 246
- Games: https://www.chess.com/game/live/186041387148 · https://www.chess.com/game/live/185943101834 · https://www.chess.com/game/live/185923290358

**3. 1.e4 e5 2.Qh5 Nc6 3.Bc4 g6 4.Qf3 Nf6 5.d3 Nd4 …** (King's Pawn Game: Wayward Queen Attack)
- FEN `r1bqkb1r/pppp1p1p/5np1/4p3/2BnP3/3P1Q2/PPP2PPP/RNB1K1NR w KQkq - 1 6` · as white · reached in 14 games
- My move **Qe3**: played 5× (results 1–0–4 | 20%) · engine's move **Qd1** · loses 36.5 Win% (pass 2; Win% before 39) · total 183
- Games: https://www.chess.com/game/live/174417205376 · https://www.chess.com/game/live/174036557516 · https://www.chess.com/game/live/173996955570

**4. 1.e4 e5 2.Qh5 Nc6 3.Bc4 g6 4.Qf3 Nf6 …** (King's Pawn Game: Wayward Queen Attack)
- FEN `r1bqkb1r/pppp1p1p/2n2np1/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 2 5` · as white · reached in 27 games
- My move **d3**: played 23× (results 8–0–15 | 35%) · engine's move **Ne2** · loses 7.9 Win% (pass 2; Win% before 47) · total 182
- Games: https://www.chess.com/game/live/174417205376 · https://www.chess.com/game/live/174411601952 · https://www.chess.com/game/live/174124656866

**5. 1.d4 e5 …** (Englund Gambit)
- FEN `rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2` · as white · reached in 91 games
- My move **Nc3**: played 18× (results 10–0–8 | 56%) · engine's move **dxe5** · loses 9.9 Win% (pass 2; Win% before 63) · total 179
- Games: https://www.chess.com/game/live/186217320930 · https://www.chess.com/game/live/186215238662 · https://www.chess.com/game/live/186211940188

**6. 1.e4 d5 …** (Scandinavian Defense)
- FEN `rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2` · as white · reached in 53 games
- My move **Qe2**: played 12× (results 6–0–6 | 50%) · engine's move **exd5** · loses 13.6 Win% (pass 2; Win% before 56) · total 164
- Games: https://www.chess.com/game/live/174324310174 · https://www.chess.com/game/live/174181667766 · https://www.chess.com/game/live/174039638576

**7. 1.e4 d5 …** (Scandinavian Defense)
- FEN `rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2` · as white · reached in 53 games
- My move **f3**: played 13× (results 2–1–10 | 19%) · engine's move **exd5** · loses 11.5 Win% (pass 2; Win% before 56) · total 150
- Games: https://www.chess.com/game/live/174121664048 · https://www.chess.com/game/live/174106345902 · https://www.chess.com/game/live/173997311814

**8. 1.d4 d5 2.Nc3 Nf6 3.Bf4 Nc6 …** (Rapport-Jobava System)
- FEN `r1bqkb1r/ppp1pppp/2n2n2/3p4/3P1B2/2N5/PPP1PPPP/R2QKBNR w KQkq - 4 4` · as white · reached in 45 games
- My move **e3**: played 27× (results 17–0–10 | 63%) · engine's move **Nb5** · loses 5.3 Win% (pass 1; Win% before 56) · total 143
- Games: https://www.chess.com/game/live/186883964096 · https://www.chess.com/game/live/186686760946 · https://www.chess.com/game/live/186626469398

**9. 1.e4 c6 2.d4 d5 3.Nc3 …** (Caro-Kann Defense)
- FEN `rnbqkbnr/pp2pppp/2p5/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR b KQkq - 1 3` · as black · reached in 48 games
- My move **Nf6**: played 20× (results 7–0–13 | 35%) · engine's move **dxe4** · loses 7.0 Win% (pass 1; Win% before 48) · total 140
- Games: https://www.chess.com/game/live/185526974234 · https://www.chess.com/game/live/184679951040 · https://www.chess.com/game/live/184673665464

**10. 1.Nf3 Nf6 2.d4 Nc6 3.Bf4 d5 4.Nc3 e5 …** (Indian Defense: Knights Variation)
- FEN `r1bqkb1r/ppp2ppp/2n2n2/3pp3/3P1B2/2N2N2/PPP1PPPP/R2QKB1R w KQkq - 0 5` · as white · reached in 3 games
- My move **e3**: played 2× (results 1–0–1 | 50%) · engine's move **dxe5** · loses 65.0 Win% (pass 2; Win% before 72) · total 130
- Games: https://www.chess.com/game/live/185862591008 · https://www.chess.com/game/live/184119099070

**11. 1.e4 e5 2.Qh5 Nc6 3.Bc4 g6 4.Qf3 Nf6 5.d3 Nd4 …** (King's Pawn Game: Wayward Queen Attack)
- FEN `r1bqkb1r/pppp1p1p/5np1/4p3/2BnP3/3P1Q2/PPP2PPP/RNB1K1NR w KQkq - 1 6` · as white · reached in 14 games
- My move **Qh3**: played 3× (results 0–0–3 | 0%) · engine's move **Qd1** · loses 36.0 Win% (pass 2; Win% before 39) · total 108
- Games: https://www.chess.com/game/live/173968808442 · https://www.chess.com/game/live/173649855532 · https://www.chess.com/game/live/173629362886

**12. 1.e4 c6 2.d4 d5 3.Nc3 …** (Caro-Kann Defense)
- FEN `rnbqkbnr/pp2pppp/2p5/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR b KQkq - 1 3` · as black · reached in 48 games
- My move **c5**: played 4× (results 0–0–4 | 0%) · engine's move **dxe4** · loses 26.0 Win% (pass 2; Win% before 47) · total 104
- Games: https://www.chess.com/game/live/186311299672 · https://www.chess.com/game/live/186253356180 · https://www.chess.com/game/live/186148995118

**13. 1.d4 …** (Queen's Pawn Game)
- FEN `rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1` · as black · reached in 322 games
- My move **Nc6**: played 16× (results 7–1–8 | 47%) · engine's move **Nf6** · loses 6.2 Win% (pass 1; Win% before 49) · total 99
- Games: https://www.chess.com/game/live/185502293966 · https://www.chess.com/game/live/185037012982 · https://www.chess.com/game/live/174174406616

**14. 1.e4 d6 2.d4 Nf6 3.e5 …** (Pirc Defense)
- FEN `rnbqkb1r/ppp1pppp/3p1n2/4P3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3` · as black · reached in 5 games
- My move **Ne4**: played 2× (results 1–0–1 | 50%) · engine's move **dxe5** · loses 48.3 Win% (pass 2; Win% before 64) · total 97
- Games: https://www.chess.com/game/live/172376371310 · https://www.chess.com/game/live/167162781038

**15. 1.e4 e5 2.Qh5 …** (King's Pawn Game: Wayward Queen Attack)
- FEN `rnbqkbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2` · as black · reached in 6 games
- My move **g6**: played 2× (results 0–0–2 | 0%) · engine's move **Nc6** · loses 46.7 Win% (pass 2; Win% before 53) · total 93
- Games: https://www.chess.com/game/live/166631656782 · https://lichess.org/YXUUhEag/black#3

**What the leaks say** (facts):
- The single biggest item is the Wayward Queen, 2.Qh5 after 1.e4 e5: 105 games, about 6 Win% each time against 2.Nf3.
- Three of the top 15 come from the same Qh5 line, at moves 2, 5 and 6.
- The Englund Gambit (1.d4 e5) appears twice: 2.Nf3 and 2.Nc3 instead of 2.dxe5.
- The Scandinavian (1.e4 d5) also appears twice: 2.Qe2 and 2.f3 instead of 2.exd5.

**Extra engine work: the position pass.**
- **Why:** leaks and "other sound ways to play" need several engine moves per position at one depth. Today only my candidate moves have a 2-line deep search.
- **What:** for each position reached ≥3 times (me to move, first 15 moves), Stockfish 19, 1 thread, hash cleared:
  - **MultiPV 5 at 5M nodes**, so 1M nodes per line, about the per-line effort of pass 2;
  - plus one search restricted to each move I played there that isn't in the top 5 (same node budget), for its score and refutation line.
- **Where it's stored:** a new write-once file per position, `data/positions/{hash}.json`, and one per extra move. Nothing already stored is recomputed or rewritten; games are never re-analyzed.
- **Cost, measured:**
  - 5M nodes took 3.9 s per position on this Mac (18 positions in 71 s). The refutation backfill ran about 2.3× slower per node on GitHub.
  - Backfill: 674 positions plus at most 1,889 extra moves gives at most about 6 engine-hours on GitHub. That is about 1.5 hours across the 4 parallel analysis jobs, and likely about half that, because many played moves are already in the top 5.
  - **Nightly:** only positions that newly reach 3 games, or new moves in them: a few seconds.
- **The same pass answers "other sound ways to play":**
  - 154 positions were reached ≥10 times and 65 ≥20 times;
  - for those reached ≥10 times, the move tree shows the engine's top 3 with Win% behind the best, next to how often I played each move and my score with it.

**Test run of the position pass** (on this Mac, same engine build and settings; nothing written to `data/`). The first rows are the leak positions above, the last are the most common positions:

| Position | Reached | Engine top 5 (Win% behind best) | Within 2 Win% | I played |
|---|---|---|---|---|
| 1.e4 e5, White to move | 227 | Nf3, Nc3 −2.3, Bc4 −2.6, d4 −2.8, Be2 −3.4 | Nf3 | Qh5×105, Nf3×88, Bc4×21, Nc3×12 |
| 1.d4 e5, White to move | 91 | dxe5, Nc3 −10.0, e3 −11.7, c3 −13.3, e4 −14.3 | dxe5 | dxe5×49, Nc3×18, Nf3×16 |
| …5.d3 Nd4, White to move (Qh5 line) | 14 | Qd1, Qg3 −26.0, Bxf7+ −29.6, Bd2 −31.5, Nc3 −32.6 | Qd1 | Qe3×5, Qd1×5, Qh3×3 |
| 1.e4 d5, White to move | 53 | exd5, e5 −6.3, d3 −6.4, Nc3 −9.5, Bd3 −9.6 | exd5 | f3×13, Qe2×12, Nc3×8, d3×8 |
| 1.e4 c6 2.d4 d5 3.Nc3, Black to move | 48 | dxe4, a6 −2.7, h6 −3.6, e6 −4.9, Be6 −6.5 | dxe4 | Nf6×20, Nd7×8, dxe4×6, c5×4 |
| 1.e4 e5 2.Qh5, Black to move | 6 | Nc6, Nf6 −0.1, d6 −0.2, Qe7 −1.2, Qf6 −2.9 | Nc6, Nf6, d6, Qe7 | Qe7×3, g6×2, Nc6×1 |
| 1.d4, Black to move | 322 | d5, Nf6 −0.2, c6 −0.6, a6 −1.2, e6 −1.5 | all 5 (list may be incomplete) | g6×157, Nf6×53, d5×49 |
| 1.Nf3 d5, White to move | 159 | d4, g3 −0.9, e3 −1.1, c3 −1.3, b3 −2.2 | d4, g3, e3, c3 | d4×135, g3×21 |

10 of the 11 leak positions tested have a short, complete list of good moves, mostly a single move. The early positions (1.d4, 1.e4, move 1) have five or more equal moves, which is why they make no leak and no card.

### A.5 Leak cards

**Which leaks become cards:** every leak that passes the rule in A.4 on the position pass, and also:
- **the list of right answers is complete:** fewer than 5 moves are within 2 Win% of the best. Every move outside the MultiPV-5 list scores no better than the 5th line, so when the 5th line is more than 2 Win% behind, no unlisted move can be right. When all 5 are within 2 Win%, the position gets no card;
- **the position has no tactics card already.** The existing card stays, since its rule is stricter. Only 2 of the 166 leak positions have one today.

**Estimate:** roughly 100–160 leak cards from today's data, set by how many leaks survive the re-measure.

**What counts as right:**

| Move played | Counts as | Banner |
|---|---|---|
| Within 2 Win% of the best | **right** | "Good move." Then all right answers are shown, with their evaluations |
| 2–5 Win% behind | wrong (retry allowed, like today) | "Playable, but there's better (−3.1 Win%). Try again." |
| My leak move | wrong, and a habit | "That's the move you usually play." Shows its stored refutation |
| Anything else | wrong | "Not one of the good moves. Try again." |

**The rest is unchanged:**
- scheduling: first answer of the day only, FSRS, the same intervals;
- Hint / Solution / My move;
- the review event format (move played, right or wrong, habit);
- **no migration:** leak cards are new card ids in a new deck called `opening`.

**Intake:**
- leak cards share the 10-new-cards-a-day cap, with **at most 3 leak cards a day** (a setting), ordered by total Win% lost;
- without a cap, the ordering rule (most occurrences first) would put all of them ahead of every tactics card for about two weeks.

**After the answer:**
- the right answers with their evaluations;
- my usual move with its refutation line;
- how many times I played it, and my score in those games.

---

## B. Insights page

### B.1 Rules for every line

**Each line shows:**
1. the statistic;
2. the sample behind it ("in 1,867 games", "over 26,736 moves");
3. a **tip** in a visibly separate box labelled "Tip (general advice, not computed from your games)".

**Thresholds:**
- **Sample:** a line is hidden unless every group it rests on has **≥50 games**, **≥500 moves** or **≥30 events** (gifts, thrown wins, and so on).
- **Comparisons** (A vs B) show only when the 95% confidence interval of the difference excludes zero.
  - For move-level rates, the nightly build computes the interval by resampling whole games, because moves in one game aren't independent.
  - Comparisons that fail are listed under a collapsed "Checked, no clear pattern" heading, with their numbers.
- **"Undecided" positions:** blunder rates count only positions where my Win% before the move is between 10 and 90, the card rule's range. In a lost or won position a move can't lose 15 Win%, so including them dilutes every rate.

**Labels**, Win% lost by one move: inaccuracy 5–10, mistake 10–15, blunder ≥15 (Lichess's lines).

**Session (exact):** games from both sites in start order. A game's start = its end time minus the clock time both players used (base + increments − final clock, per side). A new session begins when a game starts more than **15 minutes** after the previous one ended.
- **Result:** 1,421 sessions; median 2 games, maximum 21; 681 single-game sessions.
- The gaps between games: 1,279 under 2 minutes, 533 between 2 and 15 minutes, 245 between 15 and 30, and 293 between 30 and 60.

**Time of day:** start time in America/New_York (a setting, so the cloud run doesn't depend on its own clock).

**Rating:** Chess.com and Lichess pair you with opponents you are expected to beat about half the time, so raw loss rates hide effects.
- Results lines are also checked as **score minus rating-expected score**, using the Elo formula on the two ratings stored with each game.

### B.2 Lines that pass (real data, as they would read)

**1. Danger zone: where games turn**
> In positions still in the balance, you blunder **12.1** times per 100 moves in moves 1–10, **29.7** in moves 11–20, **30.4** in moves 21–30, **23.7** in moves 31–40 and **15.9** after move 40. *(44,701 moves in undecided positions)*
>
> Tip: Your games most often turn just after the opening. When development is done, slow down and check every capture and check before you move.

**2. Missed gifts**
> Opponents blundered (one move losing ≥15 Win%) **10,509** times in 2,892 games, when you weren't already winning. Your next move gave back ≥10 Win% in **5,111** of them (**48.6%**). On all your other moves the rate was **11.4%**. *(10,509 gifts; 76,470 other moves)*
>
> Tip: When your opponent's move surprises you, first ask what it leaves undefended or allows.

Caveat: opponents' moves are judged by pass 1 only (200k nodes). Their moves never get a deep check, so some "gifts" will be pass-1 noise. The gap (48.6% vs 11.4%) is far larger than that noise.

**3. Thrown wins**
> You reached a winning position (Win% ≥90, about +6 pawns) in **1,867** games and didn't win **711** (38%): bullet 289/700 (41%), blitz 236/613 (39%), rapid 186/554 (34%). How they ended:
> - **161** lost on time while still winning;
> - **258** blundered below 50% and then lost on time;
> - **231** lost on the board;
> - **61** drawn.
>
> Of the 517 that fell below 50%, **286** did so by move 20. *(1,867 games)*
>
> Tip: When you're winning, trade pieces, keep your king safe, and watch the clock: a won position still has to be finished in time.

**4. Blunders where several moves were fine** (the positions the deck leaves out)
> **7,774 of your 10,732** deep-checked blunders (72%) came in positions where at least two moves were fine (second-best within 15 Win% of the best, so these never became cards). In those, the engine's reply line won 3+ points of material **2,336** times (30%); **1,830** (24%) simply left a piece to be taken; **217** allowed a forced mate. *(7,774 blunders)*
>
> Tip: Most blunders here weren't hard positions. Before each move, check what the moved piece leaves undefended and whether it can be taken.

These are the existing tags (`loses material`, `hung piece`, `allowed mate`), applied to the excluded blunders. Exact rules: spec 4.1.

**5. Time controls side by side**
> Per 100 moves in positions still in the balance:
> - bullet: inaccuracies 12.3, mistakes 6.4, blunders **18.1** *(17,954 moves)*;
> - blitz: 11.8, 5.8, **18.0** *(13,731)*;
> - rapid: 13.2, 6.7, **20.1** *(13,016)*.
>
> Rapid is not cleaner than bullet.
>
> Tip: In rapid you have time for a blunder check on every move: what does my move leave undefended, and what are their checks and captures?

The rapid–bullet difference is 2.1 per 100 moves (95% CI +1.2 to +3.0 counting moves as independent). The game-resampled interval in the build will be wider. If it then includes zero, this line keeps the side-by-side numbers and drops the "not cleaner" sentence.

### B.3 Checked and hidden for now (no clear pattern)

These are computed every night and would appear if a pattern emerges.

| Candidate | Exact definition | Result | Why hidden |
|---|---|---|---|
| **Tilt** | Games whose two previous games in the same session were both losses, against all other games with two earlier games in the session | Loss rate 47.6% (137/288) vs 48.5% (380/784): difference −0.9 points, 95% CI −7.6 to +5.8. Rating-adjusted: +2.6 vs +0.9 points above expected (CIs −2.9 to +8.0 and −2.3 to +4.2). Blunders 13.6 vs 12.5 per 100 moves (CI +0.1 to +2.0 counting moves as independent, so borderline) | No clear effect on results. The blunder difference is too small to rely on once games are resampled |
| **Game number in session** | Score by game 1, 2, 3, 4–5, 6–10, 11+ | Score 49.2%, 48.4%, 50.0%, 48.9%, 53.7%, 54.2%. Rating-adjusted, every bucket's interval includes 0 (game 6–10: +4.0, CI −1.8 to +9.9) | No clear pattern; 11+ has only 71 games |
| **Time of day** | Start time 00–06, 06–12, 12–18, 18–24 (New York) | Score 47.5% (40 games), 49.2%, 49.8%, 49.8%. All rating-adjusted intervals include 0 | Flat; 00–06 is below the 50-game threshold |
| **Danger zone by clock** | Blunder rate by clock left (>50%, 20–50%, 10–20%, <10% of base) | 13.4, 12.4, 9.1, 8.8 per 100 moves (all moves) | Misleading: low-clock moves come late in games, when positions are simpler or decided. Not a clock effect I can separate |

### B.4 Dropped

**Speed** ("blunders on very fast moves with plenty of clock left"):
- **Exact test:**
  - my moves after move 10, with ≥50% of the base time left;
  - "very fast" = under 1 s (bullet), 2 s (blitz) or 3 s (rapid);
  - undecided positions only.
- **Result:** fast moves blundered *less*. Fast 15.3 vs other 27.4 per 100 moves in bullet, 16.7 vs 28.5 in blitz, 17.4 vs 33.4 in rapid.
- **Why dropped:** the fast moves are mostly forced or obvious replies (recaptures, the only move), so this measures how hard the position was, not haste. The stored data can't separate the two. Showing it would invite a wrong conclusion.

### B.5 Training: computed on the device, not enough data yet

**Why on the device:** review events live only on your devices and in the private progress repository. The insights file is published on the public site, so training lines must never be part of it. The app computes them from its own copy of the events, after sync.
- **First-try rate over time:** share of scheduling answers (first showing of the day) that were right, per week.
- **Most repeated habits:** cards with ≥2 showings where my wrong move equalled a move from that card's games.

**Today's data:**
- 46 events uploaded, from 2 days (2026-11-14 and 15);
- 7 scheduling answers;
- 2 habit showings.

**Thresholds:**
- first-try rate: shown from **≥100 scheduling answers over ≥14 study days**, with weekly points of ≥20 answers each;
- habits: shown when **≥5 cards** have ≥2 habit showings.

**Expected:** both stay hidden for the first few weeks.

---

## C. STOP 2: what I'd build after approval

1. **Pipeline (nightly, in the cloud):**
   - the position pass becomes a step of the existing analysis jobs (write-once files);
   - the build job writes `site/data/openings.json` and `site/data/insights.json` next to `cards.json`, plus leak cards (deck `opening`) inside `cards.json`.
   - Games are public on both sites, so these files reveal nothing new. Review data never goes into them.
2. **App screens:**
   - **Openings:** repertoire list (A.1/A.2) with colour and time-control filters → move tree per group. Each move in the tree shows my record and the engine's top 3 for positions reached ≥10 times. The tree also holds the opponents' replies (A.3) and leaks.
   - **Insights:** the B.2 lines, each with its sample size, the tip in a separate box, a collapsed "Checked, no clear pattern" list, and on-device training lines once they pass their thresholds.
   - Training stays the default screen.
3. **Navigation and the small fixes you listed:**
   - **Gear out of the top strip:** the top strip becomes empty spacing. A menu button joins the counts row (a fifth small tile) and opens Train / Openings / Insights / Settings.
   - **Settings title blurred when scrolled:** Settings and the new pages scroll inside a box that starts below the strip, so nothing ever scrolls under the status bar.
   - **"Next" caption:** reads "Back in 2 days", without repeating "Next".
   - **Cut-off line above the buttons:** after the answer, whatever doesn't fully fit starts below the fold (pushed down to the visible edge), so no half line shows. If it fits, it shows fully.
4. **Your data:**
   - no migration and no event-format change;
   - leak cards are new ids;
   - sync and scheduling code untouched;
   - tested by updating over 2.3.1 with reviews and sync in place.
5. **Report:** `docs/phase-3-report.md` covering what was built, what was tested and what I couldn't test.

**Not in this phase:** AI-written coaching notes, multi-move puzzles.

## D. Things I'd flag

1. **The leak list depends on your repertoire choices.** 2.Qh5 and the Scandinavian moves are flagged because Stockfish rates them a few Win% worse, not because they lose by force.
   - At 5–7 Win%, a leak is "a slightly worse opening move played often".
   - If you'd rather drill only real errors, raise the leak threshold to 10 Win%: 68 leaks instead of 198 with today's data.
2. **Pass-1 numbers on opponents' moves** (missed gifts) come from a shallower search than your own deep-checked moves. The direction is safe; single cases may be noisy.
3. **No insight line here is advice about you.** Every line is a count from stored data; each tip is fixed general advice attached to that line.
4. **The 15-minute session gap is my choice.** It is a setting. The tilt result doesn't depend on it: the difference is −0.4 points at 10 minutes (CI −7.6 to +6.7), −0.9 at 15 (CI −7.6 to +5.8) and −1.8 at 30 (CI −7.8 to +4.1).
