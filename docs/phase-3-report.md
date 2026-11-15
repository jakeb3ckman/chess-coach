# Phase 3 report: opening report and insights page (STOP 2)

Date: 2026-11-15. **Live:** https://jakeb3ckman.github.io/chess-coach/, **version 2.4.0**.

- **Your data:** reviews and sync carry over. No migration was needed, and the review event format didn't change (section 7).
- **Plan:** built as approved in `docs/phase-3-plan.md`, with your two changes (the leak split and the missed-gifts line) and your two additions (records side by side; score against rating over time).
- **Rules and screens:** in `docs/spec.md` sections 3, 4.2 and 6.3, plus the Phase 3 decisions.
- **Not in this phase:** AI-written coaching notes, multi-move puzzles.

## 1. Summary

| Request | Result |
|---|---|
| Openings screen | Built: repertoire, score against rating over time, opponents' replies, opening errors, repertoire choices, move tree with Stockfish's top 3 (section 4) |
| Insights screen | Built: 5 lines shown, 3 under "Checked, no clear pattern", training lines on the device (section 5) |
| Data built nightly in the cloud | The position pass runs inside the 4 analysis jobs. `openings.json` and `insights.json` are built with the cards on every run (section 2) |
| Leak split | Re-measured by the position pass: **205 leaks**, of which **130 are repertoire choices** (5–10 Win%, no cards) and **75 are errors** (10+ Win%) (section 3) |
| Leak cards | **53 cards** covering 69 of the 75 errors. A move within 2 Win% of the best is right; at most 3 new leak cards a day (section 3) |
| Missed gifts | Comparison with other moves removed. The line now shows the share I kept, partly gave back and gave back, with counts and the pass-1 caveat |
| Records side by side | At 42 positions: my usual move next to the best-scoring other move and the engine's move, when I've played each at least 5 times |
| Score against rating over time | 11 openings with 60+ games, blocks of 30 games, with 95% intervals. No opening shows a clear change yet (section 4) |
| Small fixes | Menu tile instead of the gear; dialogs and pages start below the blurred strip; "Back in 2 days"; no half line above the buttons (section 6) |

## 2. The position pass (new engine work)

- **What:** every position where I'm to move, within my first 15 moves, that I reached in at least 3 games: **674 positions**.
  - Each got a 5-line Stockfish 19 search at 5M nodes, one thread, hash cleared.
  - Every move I played there at least twice that wasn't in the top 5 got its own search with the same budget: **272 moves**.
  - Files are written once to `data/positions/` (3.7 MB). Games are never re-analyzed.
- **Cost, measured:**
  - **946 searches, 2.0 engine-hours, 9 minutes** across the 4 parallel jobs: [run 43760633748](https://github.com/jakeb3ckman/chess-coach/actions/runs/43760633748).
  - The plan estimated at most 6 engine-hours; the actual cost was a third of that.
  - **Nightly:** only positions that newly reach 3 games, or a newly repeated move in one: seconds. The step has a 30-minute budget per job.
- **One difference from the plan:** extra searches cover moves I played at least twice, not every move. The leak rule only uses moves played twice or more. A move played once shows its record in the tree, without a Win% figure.

## 3. Opening leaks after the re-measure

| | Plan (stored analysis) | Built (position pass) |
|---|---|---|
| Leaks | 198 in 166 positions | **205 in 168 positions** |
| 5–7 / 7–10 / 10–15 / 15+ Win% | 85 / 45 / 39 / 29 | 78 / 52 / 46 / 29 |
| Repertoire choices (5–10) | — | **130** |
| Errors (10+) | 68 estimated | **75** |

**The 10 worst errors** (ranked by Win% lost × times played; records are W–D–L and score in the games where I played that move):

| Position | As | My move (my record) | Engine's move (my record) | Win% lost | Card |
|---|---|---|---|---|---|
| 1.d4 e5 | White | **Nf3** ×16 (7–0–9, 44%) | **dxe5** (49 games, 23–1–25, 48%) | 16.8 | yes |
| …5.d3 Nd4 (2.Qh5 line) | White | **Qe3** ×5 (1–0–4, 20%) | **Qd1** (5 games, 2–0–3, 40%) | 37.7 | no: a tactics card already covers it |
| 1.e4 d5 | White | **f3** ×13 (2–1–10, 19%) | **exd5** (4 games, 2–0–2, 50%) | 14.3 | yes |
| 1.d4 e5 | White | **Nc3** ×18 (10–0–8, 56%) | **dxe5** (49 games, 48%) | 10.0 | yes (same card as Nf3) |
| 1.e4 d5 | White | **Qe2** ×12 (6–0–6, 50%) | **exd5** (4 games, 50%) | 13.7 | yes (same card as f3) |
| 1.d4 d5 2.Nc3 Nf6 3.Bf4 Nc6 4.Nf3 e5 | White | **e3** ×2 (1–0–1) | **dxe5** (never played) | 64.4 | yes |
| 1.e4 c6 2.d4 d5 3.Nc3 | Black | **c5** ×4 (0–0–4, 0%) | **dxe4** (6 games, 4–1–1, 75%) | 29.6 | yes |
| …5.d3 Nd4 (2.Qh5 line) | White | **Qh3** ×3 (0–0–3) | **Qd1** (5 games, 40%) | 37.1 | no: tactics card |
| 1.e4 c6 2.d4 d5 3.Nc3 | Black | **Nd7** ×8 (5–0–3, 62%) | **dxe4** (6 games, 75%) | 13.4 | yes (same card as c5) |
| 1.d4 d6 2.e4 Nf6 3.e5 | Black | **Ne4** ×2 (1–0–1) | **dxe5** (1 game, 0–0–1) | 50.8 | no: tactics card |

**The top repertoire choices** (5–10 Win%, no cards):

| Position | As | My move (my record) | Engine's move (my record) | Win% lost |
|---|---|---|---|---|
| 1.e4 e5 | White | **Qh5** (105 games, 50–0–55, 48%) | **Nf3** (88 games, 35–2–51, 41%) | 5.5 |
| 1.e4 | Black | **Nf6** (54 games, 22–1–31, 42%) | **c5** (14 games, 8–0–6, 57%) | 5.3 |
| 1.e4 c6 2.d4 d5 3.Nc3 | Black | **Nf6** (20 games, 7–0–13, 35%) | **dxe4** (6 games, 4–1–1, 75%) | 9.2 |
| …4.Qf3 Nf6 (2.Qh5 line) | White | **d3** (23 games, 8–0–15, 35%) | **Ne2** (1 game, 0–0–1) | 7.8 |
| 1.d4 Nf6 2.Nc3 d5 3.Bf4 Nc6 | White | **e3** (27 games, 17–0–10, 63%) | **Nb5** (never played) | 5.7 |
| 1.d4 Nf6 2.Nc3 d5 3.Bf4 Nc6 | White | **Nf3** (18 games, 13–2–3, 78%) | **Nb5** (never played) | 5.9 |

**Leak cards:**
- **53 cards** cover 69 error leaks; one card per position takes in every error move I played there.
- **Right answers:** 36 cards have one; 17 have two to four.
- **Errors without a card:**
  - 4 because a tactics card already covers the position;
  - 2 because 5 moves are within 2 Win% of the best, so the list of right answers might be incomplete.
- **In the app:** leak cards come first among new cards, at most 3 a day; the other 7 new cards stay tactics.
- **Answers:** a move within 2 Win% of the best is "✓ Good move". 2–5 Win% behind gives "Playable, but there's better (−4.1 Win%). Try again." One of my error moves gives "That's the move you usually play here."
- **After the answer:** the best line ("also good: …" when there are several right moves), my usual move with its count and the refutation.

## 4. Openings screen

**Repertoire:**
- per colour, with All / Bullet / Blitz / Rapid filters;
- 89 rows as White and 96 as Black, of which 47 and 37 have 10 or more games (the rest are small pooled rows);
- tapping a group shows its record by time control and "Explore the moves".

**Score against rating over time** (11 groups with 60+ games):
- **What it shows:** score minus the score the two ratings predict, per block of 30 games, oldest first, as a dot chart with 95% intervals plus a list.
- **Result:** no block in any group has an interval clear of zero, so no opening shows a clear improvement or decline yet. The screen says how to read the bars. The closest is the Caro-Kann block ending 2026-10-22: −15.0 points (interval −31.3 to +1.2).
- **Why so wide:** a block of 30 games gives intervals of about ±17 points. Only a large, steady change will show.

**Opponents' replies:** the top 10 per colour, each opening the tree at that position.

**Move tree:** 1,319 positions (reached 3+ times in my first 15 moves). Each shows:
- my results after each move;
- the Win% behind the best for the moves the position pass searched;
- Stockfish's top 3 where the position was reached 10+ times (154 positions);
- the side-by-side records you asked for (42 positions).

**Your 1.e4 e5 example:** 2.Nf3 scored *lower* than 2.Qh5: 41% over 88 games against 48% over 105. So by your rule, the better-scoring alternative there is 2.Bc4: 57% over 21 games. The screen shows all three, each with its Win% from the position pass:

| Move | Games | Score | Win% behind best |
|---|---|---|---|
| 2.Qh5 (usual) | 105 | 48% | 5.5 |
| 2.Bc4 (better-scoring) | 21 | 57% | 2.6 |
| 2.Nf3 (engine's move) | 88 | 41% | best |

**Data size:** `openings.json` is 816 KB (125 KB compressed). It downloads only when the Openings screen is first opened, so it doesn't slow down opening the app.

## 5. Insights screen (live text, all 3,233 games)

Each line shows the sample behind it. The tip sits in a separate box labelled "Tip · general advice, not computed from your games".
1. **Danger zone.** Blunders per 100 moves in positions still in the balance:

   | Moves | Blunders per 100 |
   |---|---|
   | 1–10 | 12.1 |
   | 11–20 | 29.7 |
   | 21–30 | 30.4 |
   | 31–40 | 23.7 |
   | 41+ | 15.9 |

   44,701 moves. Moves 21–30 against moves 1–10: +18.3, 95% interval +16.6 to +19.9, resampling whole games.
2. **Missed gifts** (changed as you asked). Opponents blundered 10,509 times in 2,892 games. My next move:

   | My next move | Times | Share |
   |---|---|---|
   | Kept the advantage (lost under 5 Win%) | 4,805 | 45.7% |
   | Gave back part of it (5–10 Win%) | 593 | 5.6% |
   | Gave back 10 Win% or more | 5,111 | 48.6% |

   The pass-1 caveat is shown under the line.
3. **Thrown wins.** I reached Win% ≥90 in 1,867 games and didn't win 711 (38%):
   - by time control: bullet 289/700, blitz 236/613, rapid 186/554;
   - how they ended: 161 lost on time while still winning, 258 blundered and then lost on time, 231 lost on the board, 61 drawn;
   - 286 of the 517 that fell below 50% did so by move 20.
4. **Blunders where several moves were fine.** 7,787 of 10,749 deep-checked blunders (72%). In those:
   - the reply line won 3+ points of material 2,341 times (30%);
   - 1,832 left a piece to be taken;
   - 218 allowed a forced mate.
5. **Time controls.** Blunders per 100 moves in balanced positions: bullet 18.0, blitz 18.0, rapid 20.1. Rapid minus bullet: +2.1, interval +1.1 to +3.0 with whole games resampled, so the sentence "Rapid is not cleaner than bullet" stays.

**Under "Checked, no clear pattern":**
- **tilt:** −0.9 points after two losses, interval −7.6 to +5.8;
- **game number in a session:** every bucket's interval includes zero;
- **time of day:** every bucket's interval includes zero; 00–06 has too few games.

Each would move up with its tip if a pattern became clear.

**Training lines:** computed on the device and never put in the public files. They appear from 100 first answers over 14 study days, and when 5 cards have 2+ habit showings. Until then the screen shows how far along you are.

## 6. Small fixes

- **Gear:** now a **Menu** tile at the end of the counts row (Train / Openings / Insights / Settings). The top strip is empty.
- **Settings and the menu:** they open at the bottom edge of the empty top strip (y = 106 at 393×852) and scroll inside their own box. The Settings title scrolls out of view inside the box, never under the status bar. The Openings and Insights pages scroll the same way.
- **Captions:** "Too easy · Back in 54 days" and "Next · Back in 2 days".
- **Cut-off line:** after an answer, the first item that doesn't fully fit above the buttons is moved just below the visible area, so no half line shows. Labels in the answer rows stay on one line, ending in "…" when too long.

## 7. Your data

- **Unchanged:** no database change and no event-format change, so there was nothing to migrate. Sync and scheduling code are untouched apart from the daily cap on new leak cards.
- **Update test** (same browser address, so the same on-device data):
  1. ran the 2.3.1 code with sync on to the stand-in GitHub, answered 3 cards (right with Next, wrong then Solution, right with Too easy) and synced;
  2. switched the address to 2.4.0 and reloaded.

  Results:
  - every schedule, today's set and every status were identical;
  - no leak cards were pushed into the set already in progress;
  - one more answer then synced (the stand-in's log file went from 7 to 9 lines).
- **Leak cards start the next study day,** or in an extra set the same day.

## 8. What I tested

- **Python, 64 tests** (8 new):
  - opening names by position, including a transposition;
  - score-against-rating blocks;
  - sessions and clock-based game length;
  - the fixed-seed resampling;
  - which positions qualify;
  - the position pass with real Stockfish: write-once, extra moves found, nothing rewritten;
  - leaks and leak cards checked against the stored scores: the error/repertoire split and right answers within 2 Win%.
- **App, 29 tests** (3 new, plus stricter card checks). Every card in the current export, all 53 leak cards included, is legal on the board:
  - the right answers and searched moves are legal;
  - the error move is never listed as right;
  - the engine's move comes first.
- **In the browser** at phone sizes, with your phone's 62/34 spacing simulated:
  - a fresh day's set held 3 leak and 7 tactics cards;
  - all four answer kinds behaved as designed (right, "playable", habit, wrong);
  - a card with four right answers accepted a non-best one with "✓ Good move: c5";
  - at 375 px the answer lines end at y = 703 and the buttons start at y = 707;
  - the 5 tiles fit without overflow and nothing scrolls sideways;
  - on a Mac-sized window the Openings page sits in the board-width column;
  - Openings: groups, the trend chart, the tree and the side-by-side records all render;
  - Insights renders, and the training lines report "not enough yet".
- **Live site:**
  - version 2.4.0, noindex present, no test hooks;
  - the data files are in place: cards 2,587 (53 leak), openings 1,319 positions and 205 leaks, insights 8 lines;
  - `data/positions/` is not published (404);
  - both new screens open.

## 9. What I couldn't test

1. **Your iPhone:**
   - the Menu tile under your thumb;
   - whether iOS keeps the dialogs and pages crisp below the strip;
   - scrolling the Openings and Insights pages;
   - the small board in the move tree.
2. **The first nightly run with the position step on its schedule.** The backfill used the same workflow, started by hand. Tonight's run is the first scheduled one.
3. **Your real progress repository after the update.** Sync code didn't change and the update test used the stand-in. Settings → "Sync now" after updating will confirm it.
4. **Loading `openings.json` on a phone connection** (125 KB compressed). It loads once, then works offline.
5. **The training lines with real data.** Your log has only a few days of reviews.

## 10. Things I'd flag

1. **The position pass searches each position from its own FEN,** so a position gets one result whichever game reached it. The plan's test run used the game's move history instead, and a few numbers moved a little. For example, 3...a6 in the Caro-Kann line was −2.7 Win% in the plan's test and is −4.1 in the stored pass. Everything uses the stored pass.
2. **Repertoire choices are a judgment of degree.** 2.Qh5 is 5.5 Win% behind 2.Nf3 by Stockfish, yet your record with Qh5 is better than with Nf3. Both facts are shown side by side; neither is advice.
3. **Errors without a card:** the 4 errors covered by tactics cards (in 2 positions) are already in your deck. The 2 "too many good moves" positions stay report-only.
4. **The over-time chart needs patience.** With 30-game blocks, only a change of about 17 points or more shows as clear. Most of your openings are a few months old in your data.
