# Phase 2 rework notes

Date: 2026-11-15. Scope: the trainer rework requested after the first days on the iPhone, plus the board-layout supplement. Sync has not been built. Multi-move puzzles, the opening report and an insights page were not started.

**Live:** https://jakeb3ckman.github.io/chess-coach/. Settings shows **Version 2.2.1**.

## 1. Summary

| # | Request | Result |
|---|---|---|
| — | Reviews survive the update | Migrated, not reset; tested by updating over the live build (section 2) |
| — | Update reaches the Home Screen app on its own; version in Settings | Network-first page loads and reload on update; Version 2.2.1 in Settings. The first update may need one app restart (section 2) |
| — | Stockfish is the only source of chess truth | Yes. The game-move refutation needed a new stored engine pass (section 5) |
| 1 | Lotus-style sets | Built: four counts, Missed back after 3 cards, Unsure after 5, Finish later / Resume, Set complete screen (section 3) |
| 1 | Only the first answer each day feeds the scheduler | Built; a miss returns the next day (1 day), a new card right first time in 2 days (section 3) |
| 2 | Feedback banner, habit, retry with Hint / Solution / My move | Built (section 4) |
| 2 | Solution line, game move, refutation, each with evaluation in pawns | Built; Win% kept as small detail (section 4) |
| 3 | Tags with exact rules, shown after the answer, counts and examples | 6 tags, rules in spec 4.1, counts and 5 examples each in section 6 |
| 4 | "Too easy", real return dates on buttons | Built (section 7) |
| 4 | Blurred top bar | Status bar style changed to `black`; safe-area padding kept. Not checked on a real iPhone (section 10) |
| 4 | Board too far right / clipped h-file | Root cause found and fixed; checked at 375, 390, 393 and 430 px, with simulated insets (section 7) |

## 2. Ground rules

**Existing reviews survive (migrate, don't reset).**
- The app's on-device database moves from version 1 to version 2. This adds a store for day sets and leaves the existing review log untouched.
- On first open, the new version:
  1. keeps every review event exactly as it was;
  2. stores a copy of the old card schedules (`backup_schema1_states`);
  3. recomputes each card's schedule from its own events under the new rules.
- **The new rules:** the first answer per card per study day counts; same-day re-answers are drilling; the intervals are 1 day and 2 days.
- **Habit counts:** come from old wrong answers whose move equals a move from that card's games.
- **Today:** the set is rebuilt with the statuses those events give. A card answered right first time today is Known, one missed is Missed, one missed then right is Unsure. New cards already started today count toward the 10.
- **Tested:**
  - I built the version that is live on your phone (build 84672ecce3) from git, made reviews with it on a local server, then let the new version update over it through the real offline-worker path.
  - Result: 5 of 5 events kept, the old schedule backed up, schedules recomputed as expected (details in section 9), habits counted, and today's set rebuilt with the right statuses.

**The update reaches the Home Screen app on its own.**
- Page loads now go to the network first (with a 4-second fallback to the cached copy when offline). Before, the cached page was used first, so a new version showed up only one launch later.
- When a new version takes over while the app is open, it reloads at the next card boundary, never mid-card.
- Settings shows **Version 2.2.1** and the build id.
- **One catch for this first update:** the copy on your phone has the old offline worker, which serves its cached page first.
  - The first launch after the deploy may still show the old version, while the new one installs in the background.
  - If Settings doesn't show "Version 2.2.1": swipe the app away in the app switcher and open it again.
  - From 2.2.1 on, updates arrive without this step.
- I reproduced exactly this with the old build locally: the first load was old, the reload was 2.2.1.

**Stockfish stays the only source of chess truth.**
- **Evaluations and lines:** every evaluation and line shown comes from stored engine output.
- **The game-move refutation:** needed a new stored engine pass (section 5), because pass 2 had stored only the score after my move, not the line.
- **Tags:** use only stored scores and lines plus legal-move facts from python-chess (whether a move is a capture, which piece stands on a square, material counts).
- **The Hint:** names the square of the piece that moves, taken from the stored solution.
- Nothing is judged by me.

## 3. Sessions (Lotus Chess style)

- **The day's set:** when the app first opens on a study day (from 4 a.m.), it fixes the set: every card due before the day ends, plus new cards in the approved order up to 10.
- **Statuses:** Remaining, Missed, Unsure, Known, shown as four counts in the top bar the whole time.
  - Right on the first showing: Known.
  - Wrong, Hint or Solution: Missed. The card comes back **3 cards later**, or straight away if fewer are left.
  - Right on a later showing: Missed becomes Unsure (back **5 cards later**), then Unsure becomes Known.
  - Wrong again resets it to Missed.
- **End of the set:** it is complete only when every card is Known, and then a "Set complete" screen shows.
- **Finish later:** saves the place. Reopening the same day shows "Set saved, N cards left" and **Resume**.
- **Only the first showing each day feeds the scheduler.** Exactly one event per card per day is marked as the scheduling event; every other showing is logged as drilling and never moves the card.
- **The actual intervals**, from the scheduling library with the new settings and checked by tests:

| first showing of the day | comes back |
|---|---|
| new card, missed | **next day** (1 day after the review) |
| new card, right first time | **2 days** |
| new card, right, "Too easy" | about **54 days** |
| new card right, then right again 2 days later | about 3 weeks |
| known card, missed | **next day** |
| card missed today, then right on its next showing (the next day) | 3 days |

- **The ~5 days you saw before:** that came from a scheduling-library feature called "model override", which lets FSRS-7 skip a learning step when it judges the card already known.
  - I set learning steps of 1 day and 2 days, a relearning step of 1 day, and turned model override off. All of these are the library's own settings, so nothing works against it.
  - "Next day" means due 24 hours after the answer. The next morning's set includes every card due before that study day ends, so a card missed at 11 p.m. is in tomorrow morning's set.

## 4. Feedback after a move

- **Banner:** white "White to move. Find the best move."; red after a wrong move; green when solved.
  - A solve after a miss says "(counts as missed)".
  - A revealed solution shows a red banner with the answer.
- **Habit:** if the wrong move equals a move I played from this position in any of the card's games, the banner says **"That's the move you played in the game."**
  - The showing counts as a habit on the card.
  - The count shows as a tag after the answer ("habit ×2") and is stored for later insights.
- **After a wrong first try:** the answer is not revealed.
  - The piece goes back after about half a second, and I can try again.
  - **Hint:** circles the piece that moves and says "the piece on e5 moves". Counts as missed.
  - **Solution:** reveals the answer. Counts as missed.
  - **My move:** draws the move I played in the game. It reveals nothing new.
- **Once solved or revealed:**
  - **Best line:** the engine's solution line, with its evaluation in pawns from my side (e.g. "+1.53", or "mate in 3").
  - **In the game you played Ne4:** with its evaluation (e.g. "−4.63").
  - **Refutation:** the opponent's engine line after my game move, with the same evaluation.
  - Every move is a button that shows that position on the board. ◀ ▶ step through it, and ↺ goes back to the puzzle with arrows: green for the engine's move, red for my game move, yellow for my attempt if it was something else.
  - Win% is in small grey text: "Win% 63.7 → 15.4 (−48.3)".
  - Then the tags, and links to the game and a Lichess analysis board.

## 5. The refutation pass (new engine data)

- **Why:** pass 2 stored the score of the position after each deep-checked move of mine, but not the engine's line there. A refutation without stored engine output would break the main rule.
- **What:** a new pass repeats that exact search (2M nodes, one thread, same move history, hash cleared) and keeps the line.
  - It writes a new write-once file per game, `data/refutations/{site}/{month}/{id}.json`.
  - **Existing analysis files are not touched.** The "never re-analyze a finished game" rule still holds: nothing already stored is recomputed or overwritten; this adds one new kind of file.
  - New games get both files from the same nightly job.
- **Check:** because the search is identical and Stockfish is deterministic here, the refutation's score must equal the stored score. **Result: 17,052 of 17,052 refutation scores equal the stored score; 0 mismatches.** Every card has a refutation line, and the app tests check every line is legal.
- **Cost:** 16.6 engine-hours for the backfill, run on GitHub in one pipeline run ([43658094289](https://github.com/jakeb3ckman/chess-coach/actions/runs/43658094289), 85 min, 4 shards, 0 failures). Nightly it adds about 18 s of engine time per new game, on top of about 57 s for the analysis. The files add 1.3 MB for 3,229 games (about 390 bytes per game).

## 6. Tags

The exact rules are in spec section 4.1 and the code in `coach/tags.py`.
- **Summary:**
  - `opening`: move ≤ 10.
  - `mate`: the best line is a forced mate for me.
  - `allowed mate`: after my move, a forced mate against me. This one I added; it is unambiguous.
  - `thrown win`: Win% above 90 before, below 50 after.
  - `missed capture`: the engine's best move is a capture, and my move did not capture on that same square.
  - `hung piece`: defined precisely below.
- **`hung piece`, precisely:**
  1. Stockfish's refutation of my move must start by capturing one of my knights, bishops, rooks or queen.
  2. Following the refutation line while every move is a capture (up to 8 plies), I must end at least 3 points of material worse than before my move.
  3. A trade where I get the material back does not count, and neither does a fork whose first move isn't a capture.
- **Where they show:** tags appear only after the answer.

**Counts** (2,530 cards; a card can have several tags):

| tag | cards | share |
|---|---|---|
| opening | 697 | 27.5% |
| mate | 68 | 2.7% |
| allowed mate | 162 | 6.4% |
| thrown win | 493 | 19.5% |
| missed capture | 1294 | 51.1% |
| hung piece | 467 | 18.5% |
| (no tag) | 544 | 21.5% |

**Examples:** 5 cards per tag, picked by a fixed hash, so anyone can check the rules against the positions. For each card:
- the FEN and the game link (Lichess links open at the move);
- a Lichess board at the position;
- the engine's best line and my game move, each with its stored evaluation from my side;
- the stored refutation, and the Win% before and after;
- for `hung piece`, the material lost in the capture sequence.

#### opening (697 cards)

- **feb0fe0957d2** · rapid · 2026-04-07 · I played black, move 9
  - FEN: `r3k1nr/pp3ppp/2p5/3pnb2/7q/NP2PPP1/P1PQ3P/R3KBNR b KQkq - 0 9`
  - Game: https://www.chess.com/game/live/166979295726 · board: https://lichess.org/analysis/standard/r3k1nr/pp3ppp/2p5/3pnb2/7q/NP2PPP1/P1PQ3P/R3KBNR_b_KQkq_-_0_9
  - Best: 9...Qe7 10.Nb1 O-O-O 11.Be2 Nf6 12.Nc3 Rhe8 13.Kf1 g5 14.g4 (+3.41) · I played: Qg5 (+1.41) · refutation: 10.O-O-O Qe7
  - Win% 77.8 → 62.7
- **5dadeb8d304b** · blitz · 2026-08-11 · I played black, move 6
  - FEN: `rnbqkb1r/pp2nppp/2p5/4P3/N2pPB2/8/PPP2PPP/R2QKBNR b KQkq - 3 6`
  - Game: https://www.chess.com/game/live/172850802322 · board: https://lichess.org/analysis/standard/rnbqkb1r/pp2nppp/2p5/4P3/N2pPB2/8/PPP2PPP/R2QKBNR_b_KQkq_-_3_6
  - Best: 6...Ng6 7.Bd2 (+2.58) · I played: Nd7 (-1.57) · refutation: 7.Qxd4 Ng6 8.Bg3 Qa5+ 9.Nc3 Bc5 10.Qd2 Ngxe5 11.O-O-O O-O
  - Win% 72.1 → 35.9
- **14174384e9fa** · bullet · 2026-10-24 · I played white, move 10
  - FEN: `rnbqk2r/pppp2p1/5p2/4N2p/1b1P2n1/2N1P2P/PPP1Q1P1/R3KB1R w KQkq - 0 10`
  - Game: https://www.chess.com/game/live/185887298204 · board: https://lichess.org/analysis/standard/rnbqk2r/pppp2p1/5p2/4N2p/1b1P2n1/2N1P2P/PPP1Q1P1/R3KB1R_w_KQkq_-_0_10
  - Best: 10.Ng6 Rh6 (-0.64) · I played: Nd3 (-3.24) · refutation: 10...Bxc3+ 11.bxc3 Nh6 12.Nf4 Nf7 13.Qf2 d6 14.Bd3 Rh6 15.e4
  - Win% 44.1 → 23.3
- **218ddc5d8b45** · bullet · 2026-10-17 · I played white, move 5
  - FEN: `rn1qkbnr/ppp2ppp/8/4Pb2/3pN3/8/PPP1PPPP/R1BQKBNR w KQkq - 2 5`
  - Game: https://www.chess.com/game/live/185480610970 · board: https://lichess.org/analysis/standard/rn1qkbnr/ppp2ppp/8/4Pb2/3pN3/8/PPP1PPPP/R1BQKBNR_w_KQkq_-_2_5
  - Best: 5.Ng3 Bg6 (+2.22) · I played: f3 (-0.09) · refutation: 5...Nc6 6.Ng3
  - Win% 69.4 → 49.2
- **668cc9286fb4** · bullet · 2026-10-12 · I played black, move 10
  - FEN: `r1bqk2r/ppp1p1bp/2n3p1/6P1/3PQ3/4P3/PPP2P2/R1B1KBNR b KQkq - 0 10`
  - Game: https://www.chess.com/game/live/185186320502 · board: https://lichess.org/analysis/standard/r1bqk2r/ppp1p1bp/2n3p1/6P1/3PQ3/4P3/PPP2P2/R1B1KBNR_b_KQkq_-_0_10
  - Best: 10...Bf5 11.Qf3 Nb4 12.c3 Nc2+ 13.Kd2 Nxa1 14.Bc4 Rb8 15.e4 (+2.88) · I played: Nb4 (-3.12) · refutation: 11.Bh3 Qd5 12.Qxd5 Nxd5 13.c3 e5 14.e4 Nb6 15.d5 a5
  - Win% 74.3 → 24.1

#### mate (68 cards)

- **1b6590ef3d50** · rapid · 2025-03-19 · I played white, move 15
  - FEN: `rn2kb1r/pp2pppp/2p5/2q5/3R1BQ1/6P1/2b1NK1P/5B1R w kq - 3 15`
  - Game: https://lichess.org/scB8ktLK/white#28 · board: https://lichess.org/analysis/standard/rn2kb1r/pp2pppp/2p5/2q5/3R1BQ1/6P1/2b1NK1P/5B1R_w_kq_-_3_15
  - Best: 15.Qc8# (M1) · I played: Bh3 (-5.78) · refutation: 15...e6 16.Rc1 Na6 17.Qf3 Nb4 18.Be3 Qe5 19.Nf4 Bf5 20.Bxf5
  - Win% 97.5 → 10.6
- **6669e10c661c** · rapid · 2026-08-03 · I played black, move 6
  - FEN: `rnbqkb1r/ppp3pp/4p3/3p1P2/3Pn3/3BPP2/PPP4P/RNBQK1NR b KQkq - 0 6`
  - Game: https://www.chess.com/game/live/172450775348 · board: https://lichess.org/analysis/standard/rnbqkb1r/ppp3pp/4p3/3p1P2/3Pn3/3BPP2/PPP4P/RNBQK1NR_b_KQkq_-_0_6
  - Best: 6...Qh4+ 7.Kf1 Qf2# (M2) · I played: Ng5 (-1.19) · refutation: 7.h4 Nf7
  - Win% 97.5 → 39.2
- **1d2b024760c3** · bullet · 2026-10-19 · I played black, move 17
  - FEN: `r3k2r/pp3ppp/4p3/3p4/3N2n1/2PPq3/PP4PP/R2QR2K b kq - 1 17`
  - Game: https://www.chess.com/game/live/185579177662 · board: https://lichess.org/analysis/standard/r3k2r/pp3ppp/4p3/3p4/3N2n1/2PPq3/PP4PP/R2QR2K_b_kq_-_1_17
  - Best: 17...Nf2+ 18.Kg1 Nh3+ 19.Kh1 Qg1+ 20.Rxg1 Nf2# (M4) · I played: Qf2 (-6.27) · refutation: 18.Qxg4 O-O 19.Re2 Qf6 20.Nf3 Qg6 21.Qd4 Rfd8 22.Rg1 Qf5
  - Win% 97.5 → 9.0
- **fc44547804e6** · bullet · 2026-11-01 · I played white, move 25
  - FEN: `1n1k1q2/3br3/rN2p3/3p4/1p6/6Q1/PPP2PPP/R4RK1 w - - 2 25`
  - Game: https://www.chess.com/game/live/186344598820 · board: https://lichess.org/analysis/standard/1n1k1q2/3br3/rN2p3/3p4/1p6/6Q1/PPP2PPP/R4RK1_w_-_-_2_25
  - Best: 25.Qxb8+ Bc8 26.Qxc8# (M2) · I played: Nxd7 (-0.27) · refutation: 25...Nxd7 26.a3
  - Win% 97.5 → 47.5
- **638072a6c5f4** · rapid · 2026-04-21 · I played white, move 33
  - FEN: `r1b1k2r/p4p2/4p3/Qp6/8/3RbPp1/1q4B1/5K2 w kq - 0 33`
  - Game: https://www.chess.com/game/live/167596876008 · board: https://lichess.org/analysis/standard/r1b1k2r/p4p2/4p3/Qp6/8/3RbPp1/1q4B1/5K2_w_kq_-_0_33
  - Best: 33.Qd8# (M1) · I played: f4 (-M1) · refutation: 33...Qf2#
  - Win% 97.5 → 2.5

#### allowed mate (162 cards)

- **2ed744597d5a** · blitz · 2026-09-03 · I played white, move 26
  - FEN: `Q1b5/ppk5/2pp3p/5Pp1/1n6/3P1NB1/nPqK2PP/5B1R w - - 0 26`
  - Game: https://www.chess.com/game/live/173914072022 · board: https://lichess.org/analysis/standard/Q1b5/ppk5/2pp3p/5Pp1/1n6/3P1NB1/nPqK2PP/5B1R_w_-_-_0_26
  - Best: 26.Ke1 Qc5 (+0.85) · I played: Ke3 (-M10) · refutation: 26...Nd5+ 27.Ke4 Nf6+ 28.Ke3 Ng4+ 29.Ke4 Qc5 30.Bxd6+ Qxd6 31.Qxc8+
  - Win% 57.8 → 2.5
- **090e880aa27e** · blitz · 2026-08-24 · I played black, move 19
  - FEN: `q6r/p2bkppp/Q2p4/3R4/4n3/8/PPP2PPP/2K2B1R b - - 0 19`
  - Game: https://lichess.org/pRZstqxd/black#37 · board: https://lichess.org/analysis/standard/q6r/p2bkppp/Q2p4/3R4/4n3/8/PPP2PPP/2K2B1R_b_-_-_0_19
  - Best: 19...Qxd5 20.Bd3 Nc5 21.Re1+ Kf6 22.Qc4 Nxd3+ 23.Qxd3 Qxd3 24.cxd3 (+6.11) · I played: Nxf2 (-M5) · refutation: 20.Qxd6+ Ke8 21.Qxd7+ Kf8 22.Qd6+ Kg8 23.Qd8+ Qxd8 24.Rxd8#
  - Win% 90.5 → 2.5
- **cf8611e1f3ae** · rapid · 2026-04-20 · I played white, move 34
  - FEN: `8/p3k1BP/1p4B1/2p5/1PP5/5r2/P1K2nPP/4q3 w - - 0 34`
  - Game: https://www.chess.com/game/live/167552165888 · board: https://lichess.org/analysis/standard/8/p3k1BP/1p4B1/2p5/1PP5/5r2/P1K2nPP/4q3_w_-_-_0_34
  - Best: 34.gxf3 Qe6 (+2.17) · I played: h8=Q (-M17) · refutation: 34...Qd1+ 35.Kb2 Nd3+ 36.Bxd3 Rf2+ 37.Ka3 Qxd3+ 38.Bc3 cxb4+ 39.Kb3
  - Win% 69.0 → 2.5
- **e6d5d86fdcd8** · blitz · 2026-08-19 · I played white, move 19
  - FEN: `7r/Q4pkp/4p1p1/3pP3/4n3/4P3/PPq2PPP/R3K2R w KQ - 0 19`
  - Game: https://www.chess.com/game/live/173221106480 · board: https://lichess.org/analysis/standard/7r/Q4pkp/4p1p1/3pP3/4n3/4P3/PPq2PPP/R3K2R_w_KQ_-_0_19
  - Best: 19.O-O Rc8 20.f3 Nd2 21.Rfe1 Rc4 22.Qe7 Qxb2 23.Qf6+ Kg8 (+3.48) · I played: Qb7 (-M2) · refutation: 19...Qd2+ 20.Kf1 Qxf2#
  - Win% 78.3 → 2.5
- **c698b1909ae7** · bullet · 2026-10-14 · I played black, move 19
  - FEN: `r3kb1r/1p1n1ppp/p3p3/3pNn2/Q2P3q/1P4B1/P1P2PPP/RN2K2R b KQ - 3 19`
  - Game: https://www.chess.com/game/live/185329845666 · board: https://lichess.org/analysis/standard/r3kb1r/1p1n1ppp/p3p3/3pNn2/Q2P3q/1P4B1/P1P2PPP/RN2K2R_b_KQ_-_3_19
  - Best: 19...Qe4+ 20.Kd1 b5 21.Nc3 bxa4 22.Nxe4 Nxe5 23.Bxe5 dxe4 24.bxa4 (+6.75) · I played: Qg5 (-M1) · refutation: 20.Qxd7#
  - Win% 92.3 → 2.5

#### thrown win (493 cards)

- **47d0d3bec388** · bullet · 2026-11-10 · I played black, move 8
  - FEN: `r1bqk2r/ppp1pBbp/5np1/4n3/8/2N2N2/PPP2PPP/R1BQK2R b KQkq - 0 8`
  - Game: https://www.chess.com/game/live/186943506298 · board: https://lichess.org/analysis/standard/r1bqk2r/ppp1pBbp/5np1/4n3/8/2N2N2/PPP2PPP/R1BQK2R_b_KQkq_-_0_8
  - Best: 8...Nxf7 9.Qxd8+ Nxd8 10.Nb5 O-O 11.Nxc7 Rb8 12.c3 b5 13.O-O (+6.64) · I played: Kxf7 (-5.11) · refutation: 9.Nxe5+ Ke8 10.Qxd8+ Kxd8 11.Nf7+ Ke8 12.Nxh8 Bxh8 13.Bg5 Bd7
  - Win% 92.0 → 13.2
- **49a91c9d1061** · rapid · 2026-05-13 · I played white, move 13
  - FEN: `r3kb1r/3n1ppp/p3pn2/qp1p4/B2P4/2N2Q1P/PPPB1PP1/R4RK1 w kq - 0 13`
  - Game: https://www.chess.com/game/live/168670329966 · board: https://lichess.org/analysis/standard/r3kb1r/3n1ppp/p3pn2/qp1p4/B2P4/2N2Q1P/PPPB1PP1/R4RK1_w_kq_-_0_13
  - Best: 13.Nxd5 Qd8 14.Nc7+ Qxc7 15.Qxa8+ Nb8 16.Bb3 Bd6 17.Qf3 Nc6 (+6.24) · I played: b4 (-5.99) · refutation: 13...Bxb4 14.Bxb5 axb5 15.a3 Bxc3 16.Bxc3 Qc7 17.Bb4 Nb6 18.Rfe1
  - Win% 90.9 → 9.9
- **1bf61dc805c8** · blitz · 2026-07-28 · I played black, move 12
  - FEN: `r1bqk2r/pp4bp/2p1p1p1/3p4/Pn4nP/1PN1PN2/2P1BPP1/R1BQK2R b KQkq - 1 12`
  - Game: https://www.chess.com/game/live/172202370834 · board: https://lichess.org/analysis/standard/r1bqk2r/pp4bp/2p1p1p1/3p4/Pn4nP/1PN1PN2/2P1BPP1/R1BQK2R_b_KQkq_-_1_12
  - Best: 12...Bxc3+ 13.Bd2 Bxa1 14.Bxb4 Qf6 15.O-O Bc3 16.Bc5 b6 17.Ba3 (+7.03) · I played: Kf8 (-0.60) · refutation: 13.Bb2 a5
  - Win% 93.0 → 44.5
- **53e189c5c5a4** · rapid · 2026-04-09 · I played white, move 12
  - FEN: `r2qkb1r/ppp3pp/4p3/3p1pB1/3P4/2NPPP2/PP3P1P/2KR1B1R w kq - 0 12`
  - Game: https://www.chess.com/game/live/167070610222 · board: https://lichess.org/analysis/standard/r2qkb1r/ppp3pp/4p3/3p1pB1/3P4/2NPPP2/PP3P1P/2KR1B1R_w_kq_-_0_12
  - Best: 12.Bxd8 Rxd8 13.Kb1 Be7 14.h4 h5 15.Ne2 Rd6 16.Ng1 g6 (+6.18) · I played: e4 (-8.11) · refutation: 12...Qxg5+ 13.Kb1 Bb4 14.exd5 Qe7 15.Re1 Bxc3 16.bxc3 Qa3 17.Bh3
  - Win% 90.7 → 4.8
- **db1f43062fb5** · rapid · 2026-04-16 · I played white, move 11
  - FEN: `r1b2rk1/p1p2ppp/1p2pq1n/2bp4/5B2/1PQP1BP1/P1P1PP1P/RN3RK1 w - - 2 11`
  - Game: https://www.chess.com/game/live/167372177640 · board: https://lichess.org/analysis/standard/r1b2rk1/p1p2ppp/1p2pq1n/2bp4/5B2/1PQP1BP1/P1P1PP1P/RN3RK1_w_-_-_2_11
  - Best: 11.Qxf6 gxf6 12.Bxh6 Rd8 13.a4 a5 14.Bg2 e5 15.Bd2 Bg4 (+7.39) · I played: Bxc7 (-0.90) · refutation: 11...Bd4 12.Qc6
  - Win% 93.8 → 41.8

#### missed capture (1294 cards)

- **03c1ea40d2fa** · blitz · 2026-07-14 · I played white, move 25
  - FEN: `r6r/pppbk1p1/5p2/3q1P2/3nNpP1/P7/P4Q1P/R2R2K1 w - - 0 25`
  - Game: https://www.chess.com/game/live/171540043872 · board: https://lichess.org/analysis/standard/r6r/pppbk1p1/5p2/3q1P2/3nNpP1/P7/P4Q1P/R2R2K1_w_-_-_0_25
  - Best: 25.Rxd4 Qc6 (+2.14) · I played: Qxf4 (-8.99) · refutation: 25...Ne2+ 26.Kf2 Nxf4 27.Rxd5 Nxd5 28.Kg3 Rae8 29.Nc5 Kf7 30.Rd1
  - Win% 68.7 → 3.5
- **d8a029b3e3c1** · blitz · 2026-08-25 · I played white, move 12
  - FEN: `r1bqk2r/ppp1bp1p/6p1/3n4/2B5/2QP4/PP1N1PPP/n1B2KNR w kq - 0 12`
  - Game: https://www.chess.com/game/live/173507081174 · board: https://lichess.org/analysis/standard/r1bqk2r/ppp1bp1p/6p1/3n4/2B5/2QP4/PP1N1PPP/n1B2KNR_w_kq_-_0_12
  - Best: 12.Qxh8+ Kd7 13.Qxd8+ Kxd8 14.Bxd5 Ke8 15.Bf3 Nc2 16.a3 Nd4 (+6.07) · I played: Bxd5 (-5.08) · refutation: 12...O-O 13.Be4 Bf6 14.Qc5 Qd6 15.Qxd6 cxd6 16.Ne2 Be6 17.Nc3
  - Win% 90.3 → 13.3
- **357c8b7f10ee** · rapid · 2026-09-17 · I played black, move 26
  - FEN: `1r1r2k1/R1p1p1bp/1p2q3/6P1/3P1P1P/1PP3PR/1P1K2BN/2B3N1 b - - 0 26`
  - Game: https://www.chess.com/game/live/183959723902 · board: https://lichess.org/analysis/standard/1r1r2k1/R1p1p1bp/1p2q3/6P1/3P1P1P/1PP3PR/1P1K2BN/2B3N1_b_-_-_0_26
  - Best: 26...Bxd4 27.cxd4 Rxd4+ 28.Kc3 Rd1 29.Bd2 Rxg1 30.Bf1 Rxf1 31.Nxf1 (+6.58) · I played: Rd7 (-5.70) · refutation: 27.Ne2 c5 28.Rxd7 Qxd7 29.Nf3 Qd5 30.Rh2 Qxb3 31.Rh1 Rd8
  - Win% 91.9 → 10.9
- **1723f492f897** · bullet · 2026-09-02 · I played black, move 11
  - FEN: `r1bq1rk1/pppp1pbp/2n3p1/4P3/3Pn3/1PP1P1PP/P2N2B1/R1BQK1NR b KQ - 2 11`
  - Game: https://www.chess.com/game/live/173886747894 · board: https://lichess.org/analysis/standard/r1bq1rk1/pppp1pbp/2n3p1/4P3/3Pn3/1PP1P1PP/P2N2B1/R1BQK1NR_b_KQ_-_2_11
  - Best: 11...Nxg3 12.Rh2 d6 13.Bxc6 bxc6 14.Qf3 Nh5 15.Rf2 Be6 16.Ne2 (+2.98) · I played: Nxd2 (-1.71) · refutation: 12.Bxd2 Ne7
  - Win% 75.0 → 34.8
- **2c9482522cac** · rapid · 2026-04-09 · I played white, move 22
  - FEN: `rn3rk1/1p3p2/p2q2p1/2ppbB2/5P1Q/1P4P1/P6P/1R3RK1 w - - 0 22`
  - Game: https://www.chess.com/game/live/167067734340 · board: https://lichess.org/analysis/standard/rn3rk1/1p3p2/p2q2p1/2ppbB2/5P1Q/1P4P1/P6P/1R3RK1_w_-_-_0_22
  - Best: 22.fxe5 Qxe5 23.Bxg6 fxg6 24.Rxf8+ Kxf8 25.Qd8+ Kg7 26.Rf1 Qe3+ (+0.00) · I played: Bg4 (-7.53) · refutation: 22...Bd4+ 23.Kg2 Nc6 24.f5 Kg7 25.Qg5 Bf6 26.Qd2 Rae8 27.Bf3
  - Win% 50.0 → 5.9

#### hung piece (467 cards)

- **ec54816a8ac0** · rapid · 2026-04-20 · I played white, move 26
  - FEN: `3r3r/p3k2p/1p4p1/2p2PNB/2P2p2/2B1P3/PP4PP/2K4n w - - 2 26`
  - Game: https://www.chess.com/game/live/167552165888 · board: https://lichess.org/analysis/standard/3r3r/p3k2p/1p4p1/2p2PNB/2P2p2/2B1P3/PP4PP/2K4n_w_-_-_2_26
  - Best: 26.f6+ Ke8 27.Bf3 fxe3 28.Bc6+ Kf8 29.Ne6+ Kf7 30.Ng5+ (+0.00) · I played: b4 (-6.74) · refutation: 26...gxh5 27.bxc5 bxc5 28.f6+ Kd7 29.exf4 Nf2 30.f5 Rhf8 31.Ba1
  - Win% 50.0 → 7.7 · material lost in the capture sequence: 3
- **b85bf16017ac** · blitz · 2026-10-17 · I played black, move 7
  - FEN: `rn2kbnr/pp2qppp/4p3/1B1pNb2/3P4/2N5/PPP2PPP/R1BQK2R b KQkq - 3 7`
  - Game: https://www.chess.com/game/live/185480374068 · board: https://lichess.org/analysis/standard/rn2kbnr/pp2qppp/4p3/1B1pNb2/3P4/2N5/PPP2PPP/R1BQK2R_b_KQkq_-_3_7
  - Best: 7...Kd8 8.g4 Bg6 9.Qf3 f6 10.Nxg6 hxg6 11.Bf4 a6 12.Ba4 (-2.27) · I played: Nd7 (-8.00) · refutation: 8.Bxd7+ Kd8 9.Bb5 f6 10.Nf3 Qc7 11.Bd3 Ne7 12.O-O h5
  - Win% 30.2 → 5.0 · material lost in the capture sequence: 3
- **05610e1b0413** · bullet · 2026-10-30 · I played black, move 13
  - FEN: `r2q1rk1/1pp1nppp/3bp3/pP1p4/3P2n1/P1NPPN1P/3B1PP1/R2Q1RK1 b - - 0 13`
  - Game: https://www.chess.com/game/live/186245327890 · board: https://lichess.org/analysis/standard/r2q1rk1/1pp1nppp/3bp3/pP1p4/3P2n1/P1NPPN1P/3B1PP1/R2Q1RK1_b_-_-_0_13
  - Best: 13...Nh6 14.e4 Ng6 15.Qc1 Kh8 16.Bxh6 gxh6 17.Qxh6 Rg8 18.Ne2 (-1.21) · I played: Bh2+ (-7.30) · refutation: 14.Nxh2 Nxh2 15.Kxh2 c6 16.a4 Rc8 17.g3 Nf5 18.Ne2 cxb5
  - Win% 39.0 → 6.4 · material lost in the capture sequence: 3
- **bd24ca86f5f3** · bullet · 2026-11-02 · I played white, move 13
  - FEN: `r1b2rk1/3nbpp1/pq2pn1p/1p1p2N1/3P1B2/2NB4/PPP1QPPP/R4RK1 w - - 0 13`
  - Game: https://www.chess.com/game/live/186371884456 · board: https://lichess.org/analysis/standard/r1b2rk1/3nbpp1/pq2pn1p/1p1p2N1/3P1B2/2NB4/PPP1QPPP/R4RK1_w_-_-_0_13
  - Best: 13.Nf3 Bd6 14.Bxd6 Qxd6 15.a3 Bb7 16.Nd1 Nh5 17.Ne5 Nf4 (+0.12) · I played: Bh7+ (-6.48) · refutation: 13...Nxh7 14.Nxh7 Kxh7 15.Nxd5 exd5 16.Qxe7 Qxd4 17.Qd6 Qf6 18.Qxd5
  - Win% 51.1 → 8.4 · material lost in the capture sequence: 3
- **65efd6621481** · bullet · 2026-09-05 · I played white, move 5
  - FEN: `rn1qkb1r/ppp2ppp/3p3n/4p2Q/2B1P1b1/3P4/PPP2PPP/RNB1K1NR w KQkq - 1 5`
  - Game: https://www.chess.com/game/live/174012180302 · board: https://lichess.org/analysis/standard/rn1qkb1r/ppp2ppp/3p3n/4p2Q/2B1P1b1/3P4/PPP2PPP/RNB1K1NR_w_KQkq_-_1_5
  - Best: 5.Qg5 Qxg5 6.Bxg5 Be7 7.Bxh6 gxh6 8.Nc3 c6 9.Nd1 Nd7 (+0.32) · I played: Qh4 (-9.71) · refutation: 5...Qxh4 6.Bb3 Qd8 7.h3 Be6 8.c4 b5 9.Nf3 a5 10.Nc3
  - Win% 52.9 → 2.7 · material lost in the capture sequence: 9

**What the rules do and don't catch** (from reading these examples):
- **`hung piece`** catches pieces left en prise (5.Qh4?? Qxh4 loses the queen outright) and failed sacrifices where the capture sequence nets a piece (13.Bh7+? Nxh7 14.Nxh7 Kxh7).
  - It deliberately misses knight forks that start by taking a pawn. For example 6.Qe3?? Nxc2+ 7.Ke2 Nxe3 wins the queen, but the first move takes a pawn, so it doesn't fit "a piece left hanging".
  - A separate `fork` tag would need its own exact rule. I didn't add one.
- **`missed capture`** is broad (51% of cards): every position where the engine's move takes something and I didn't take on that square. Many of these are ordinary recaptures.
  - It is unambiguous, but it doesn't say whether the capture wins material. "Missed winning capture" would need a material rule like the hung-piece one. I can add it if you want.

## 7. Buttons and fixes

- **"Easy" is now "Too easy".** After a right first try, both buttons show the real return date for that card, computed by the scheduler for that exact card: "Too easy · Next: back in 54 days" and "Next · Next: back in 2 days".
- **Other cases:** a single Next, captioned with what happens: "Again in a few cards, then back tomorrow" (missed), "Once more later in this set" (unsure), or "Known for today · back tomorrow".
- **Button position:** the buttons stay fixed at the bottom of the panel, so they never scroll out of reach.
- **Blurred top bar:** the status bar style is now `black` (an opaque bar, with the app laid out below it) instead of `black-translucent`.
  - With `black-translucent`, iOS draws the app underneath the status bar, where it is overlaid and blurred.
  - The top bar also keeps safe-area padding, in case insets apply.
- **The board too far right, and the clipped h-file:** the clipped "h" was a symptom. Cause: chessground's default stylesheet places the file letters 24 px to the right of the board (`left: 24px; width: 100%`) and the rank numbers 20 px above it.
  - On a 375 px screen the letters reached x = 396, so the page was 21 px wider than the screen, and iOS let the whole page sit offset. I measured this in the old build: page width 396 on a 375 screen.
  - **Fix:** the letters and numbers now sit inside the board's edge squares, and the board's width is 100% of the app's content area instead of 100% of the screen width (so safe-area side padding can never push it out).
  - A backstop stops sideways page scrolling.
- **Measured at 375, 390, 393 and 430 px wide:**
  - The page width equals the screen width (no sideways scroll).
  - The board touches both edges equally (0 / 0).
  - The letters sit inside the board.
  - I repeated this with the Home Screen app's insets simulated (47 or 59 px top, 34 px bottom), and with 20 px side insets (as in landscape), where the board shrinks to 353 px with exactly 20 px on each side.
  - What can't be emulated is iOS's own values for the insets (section 10).

## 8. Not in this rework, but its data is kept

- Sync, multi-move puzzles, the opening report and an insights page are not built.
- **The data they need is kept:**
  - every showing is an event: the move tried, correct or not, attempt number, time since the card appeared, hint / solution / my-move use, habit flag, status before and after, and the study day;
  - the full refutation lines;
  - every mistake with its tags and exclusion reasons (`data/derived/mistakes.jsonl`, rebuilt each run).
- Tilt statistics (for example, missing more after a miss) can be computed later from the event log, which records order and time.

## 9. What I tested

- **Python:** 55 tests pass, 7 of them new (the export tests were also updated):
  - the refutation pass repeats the stored search exactly;
  - refutations are added to already-analyzed games without touching their analysis files;
  - every tag follows its rule;
  - the hung-piece capture sequence;
  - material counting;
  - evaluation text from my side;
  - the app export.
- **App:** 18 tests pass.
  - **Intervals:** miss → 1 day; right → 2 days; Too easy → more than a week; a known card missed → 1 day.
  - **Drilling:** same-day drilling doesn't move the schedule, for both the new and the old event format.
  - **Replay:** order-independent, and duplicate events count once.
  - **Set rules:** Missed / Unsure / Known transitions; a missed card comes back 3 cards later and an unsure one 5 later; the last missed card comes straight back; the set completes only when everything is Known.
  - **Set contents:** cards due before day end plus at most 10 new, minus new cards already started today; on the update day, earlier reviews keep their statuses.
  - **Speed:** making a set with a simulated year of reviews (4,000 over 2,530 cards) takes well under 50 ms.
  - **Every current card:** the solution, the engine line, the game move and the refutation line are legal; tags are known; evaluations are well-formed.
- **Migration, in the browser:** the live 2.2 build (84672ecce3) ran locally and wrote real old-format data; then the new build took over through the offline worker.
  - The first load was still the old version, and the reload was 2.2.1.
  - **Events and backup:** 5 of 5 kept; old schedule backed up; the database moved from version 1 to 2.
  - **Today's statuses:** the card missed today is Missed, due the next day, habit 1. The card missed then right is Unsure, due the next day. The card right first time is Known, due in 2 days.
  - **Older card and set size:** the card answered 2 days ago is due today; the set is 11 cards (3 done today + 1 due + 7 new).
- **Flows, in the browser at iPhone sizes:**
  - **Wrong moves:** a wrong habit move gives the red banner "That's the move you played in the game"; a wrong non-habit move says "Not the best move. Try again."
  - **Retry tools:** the piece goes back after a wrong move; Hint (circle and text), My move (arrow and text) and Solution all work.
  - **Solved:** solved after a miss shows "(counts as missed)"; solved first try shows Too easy / Next with "back in 54 days" / "back in 2 days".
  - **Grading on reopen:** a right first answer left without pressing Next is graded Good when the app reopens.
  - **Resume:** Finish later, reload, then Resume works.
  - **Whole set:** a full 11-card set completed through Missed → Unsure → Known, with the "Set complete" screen.
  - **Refutation:** stepping through the refutation on the board works.
- **Event log check:** read straight from the device database.
  - Only the first showing of a card each day carries `sched: true`.
  - Drilling showings of cards already scheduled today don't move them.
- **Live site after deploy:**
  - version 2.2.1;
  - noindex on the page and the 404 page;
  - status bar `black`;
  - `cards.json` format 2 with 2,530 cards, all with refutations;
  - `data/refutations/` not published (404);
  - Settings shows "Version 2.2.1 (build 634b006df9)".

## 10. What I couldn't test without a real iPhone

1. **The blurred top bar.** I changed the cause I believe is responsible (`black-translucent` → `black`), but the browser here can't show iOS's status bar.
   - Please check the top of the app after the update.
   - If it is still blurred, send a screenshot.
2. **Safe-area insets in the Home Screen app.** I simulated typical values (47 or 59 px top, 34 px bottom, 20 px sides) and the layout held.
   - The real `env(safe-area-inset-*)` values only exist on the device.
   - With the `black` status bar, iOS should report a top inset of 0, because the app starts below the bar.
3. **The update reaching your installed app.** I tested the same update path in Chrome, but iOS may keep the old app suspended rather than reloading it.
   - If Settings doesn't say 2.2.1, swipe the app away and reopen it once.
4. **Your real reviews being migrated.** The migration ran on data written by the same build you have, but not on your phone's actual data.
   - The old schedules are kept in a backup on the device, so nothing is lost even if something looks wrong.
   - Settings → "Save a backup of my reviews" exports every event before or after the update.
5. **Thumb feel:**
   - retry after a wrong move (the piece goes back after 0.65 s);
   - the Hint circle;
   - scrolling the move strips sideways;
   - the bottom buttons staying fixed while the panel scrolls.
6. **The share sheet** for the backup button.

## 11. Things I disagree with or would flag

1. **"Too easy" on a new card means about 54 days.** That is FSRS-7's own first interval for Easy, and it is a big jump from 2 days.
   - I left it as the library sets it, and the button says "back in 54 days" before you press it.
   - If you'd rather it be shorter, the honest fix is a 3-step learning ladder, not a cap I invent.
2. **`missed capture` is too broad to be useful on its own** (51% of cards).
   - It is unambiguous as written, but it mostly says "the answer is a capture", which slightly gives the answer away even after the fact.
   - I'd consider replacing it with "missed winning capture" under a material rule. That needs your OK, since the rule must be exact.
3. **`opening` = my first 10 moves** is a crude stand-in for "the opening". Phase 3's ECO data would give a better definition. I kept the move-count rule because it is exact.
4. **Learning steps count in whole days (1 day / 2 days).**
   - A card missed late in the evening is due 24 hours later. Tomorrow's set includes it anyway, because the set takes everything due before that study day ends (4 a.m.).
   - So "about the next day" holds, but the stored due time is 24 hours after the answer, not "tomorrow morning".
5. **Today's set is fixed when the app first opens that day.** New cards that the nightly run adds during the day appear tomorrow. This keeps the set stable, as Lotus does.
6. **The refutation needed new engine work** (16.6 engine-hours once, about 18 s per new game afterwards).
   - I judged that inside the rules: it adds a new write-once file and never re-analyzes or rewrites stored analysis.
   - The alternative, showing a 200k-node best move from pass 1 next to a 2M-node score, would have mixed depths.

## 12. What to do on your iPhone (about 2 minutes)

1. Open **Chess Coach** from your Home Screen.
2. Tap ⚙︎ and check it says **Version 2.2.1**. If not, swipe the app away in the app switcher and open it again.
3. Do today's set. Your earlier reviews are still there: cards you already did today show as Known, Missed or Unsure.
4. Look at the top bar: tell me if it is still blurred, and whether the board now fits with equal space on both sides.

Sync has not been built.
