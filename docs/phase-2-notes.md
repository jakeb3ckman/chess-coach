# Phase 2 notes: milestones 2.1 and 2.2

Date: 2026-11-14. Scope: the eight instructions given at the start of Phase 2. Work stops after milestone 2.2; sync (2.3) has not been started.

## 1. Summary

| # | Instruction | Result |
|---|---|---|
| 1 | Stop after 2.2 | Done. The local-only trainer with the daily queue is live; sync has not been started |
| 2 | Deep-check every move in 30 games on GitHub | Done (section 2). Pass 1 missed **3 of 167** mistakes or blunders (1.8%); **0 of 30 cards** were missed |
| 3 | Reconcile 292 vs 1 | Both counts are right; they count different things. 293 games against the computer are excluded, and the report mislabeled its 1 game (section 3) |
| 4 | GPL-3.0 LICENSE | Added |
| 5 | Card rules unchanged; keep "avoid the blunder" data | Rules unchanged; the data is rebuilt every run (section 5) |
| 6 | noindex from the first deploy | Done, and the build fails if any page lacks the tag; checked on the live site |
| 7 | Design for token expiry, in-app token entry, constant open time | In the spec (section 6.2); the parts 2.2 needs are built (section 7) |
| 8 | Board is the whole experience; thumb moves; engine line and game link after a wrong answer | Built and tested at iPhone size in the browser, not yet on a real iPhone (section 6) |

**App:** https://jakeb3ckman.github.io/chess-coach/

## 2. What the pass-1 screen misses

**Background:** the pipeline searches every position quickly (pass 1, 200k nodes). It deep-checks a move (pass 2: 2M nodes, MultiPV 2) only if pass 1 shows a drop of at least 7 Win% and I was at or above 5 Win%. Only deep-checked moves can become cards.

**The check:**
- `scripts/screen_miss_check.py` deep-checked **every one of my moves** in a 30-game sample, with exactly the pass-2 settings, and compared the labels with what the pipeline produced from the stored analysis.
- The sample: 5 games each from Chess.com and Lichess bullet, blitz and rapid, picked by a fixed hash. It is a different sample from the repeatability check.
- **Run on GitHub:** [screen-check run 43593665567](https://github.com/jakeb3ckman/chess-coach/actions/runs/43593665567), Intel Xeon 6975P-C, 4 workers, 24 min.
- **Full result:** `docs/evidence/screen-check-run-43593665567.json` (every compared move, with FEN and engine output).

| | count |
|---|---|
| My moves in the 30 games | 935 |
| Deep-checked by the pipeline (pass-1 candidates) | 197 |
| …reproduced identically by the full run | 197 of 197 |
| Mistakes or blunders found by deep-checking every move | 167 |
| …also found by the pipeline | 164 |
| **Missed by the screen** | **3** (2 mistakes, 1 blunder) |
| Cards from deep-checking every move | 30 |
| Cards from the pipeline | 30, the same positions |
| **Cards missed** | **0** |
| Inaccuracies missed (these never become cards) | 9 |
| Pipeline inaccuracies the deep check rated below 5 Win% (pass-1-only labels) | 16 |

**The 3 missed moves:**
- All 3 had a pass-1 drop below 7: 1.7, 0.0 and 6.4.
- The deep check found 12.8, 10.8 and 16.3.
- **All 3 fail the "best move clearly best" rule** (second-best move within 15 Win%), so none would have become a card.

| game | move | pass-1 drop | deep drop | label | why it isn't a card |
|---|---|---|---|---|---|
| [Lichess rapid](https://lichess.org/1aQhMABF/white#18), move 10 | Qxc3 | 1.7 | 12.8 | mistake | best not clearly best |
| [Chess.com rapid](https://www.chess.com/game/live/167208966980), move 47 | Nc7+ | 0.0 | 10.8 | mistake | best not clearly best |
| [Chess.com bullet](https://www.chess.com/game/live/185669758154), move 9 | Nc3 | 6.4 | 16.3 | blunder | best not clearly best |

**What it means:**
- In this sample the screen loses about 2% of mistakes and blunders. Those were positions where several moves are close, which the card rules exclude anyway.
- **Scaled to all 3,227 games:** roughly 280 mistakes or blunders are missed, out of about 13,850 found.
- **Uncertainty:**
  - With 3 misses in 167, the true miss rate could plausibly be up to about 5%.
  - With 0 missed cards in 30, the sample can't rule out a small card loss. A rough upper bound is 1 in 10 cards. The fact that all 3 misses fail the clearly-best rule suggests it is much lower.
- **The trade-off:** deep-checking every move would cost about 3× the engine time per game (5,351 engine-seconds for these 30 games, about 178 s per game, against about 61 s per game today).
- **Recommendation:** keep the screen as it is.
- **Not changed:** no setting was changed.

## 3. Lichess exclusions: 292 or 1?

**Both numbers are right. They count different things, and the report described its 1 game wrongly.**

The account has 548 Lichess games in total, according to the Lichess user API (`count.all`). I downloaded the header of every one and sorted them:

| games | type | rated? | opponent | what the pipeline does |
|---|---|---|---|---|
| 127 / 64 / 64 | blitz / bullet / rapid | rated | human | imported (255) |
| 292 | correspondence, no clock | casual | Lichess computer | **never downloaded**: the import asks Lichess only for `perfType=bullet,blitz,rapid` |
| 1 | rapid, with clock | casual | Lichess computer | downloaded (it matches `rapid`), then **skipped** as a computer game |

- **The spec's "292 correspondence + 1 vs-computer":** written from the account totals before the importer existed, so it counted every game on the account.
- **The Phase 1 report's "1":** came from the importer's skip counter, which only sees games Lichess sends back. The 292 correspondence games never reach it.
- **The error:** the report called that 1 game a "correspondence game against the computer". It is a casual rapid game against the computer.
- **Fixed:** both lines now say 293 games against the computer, split 292 + 1 (spec section 1, Phase 1 report section 14).

## 4. License

`LICENSE` holds the GPL-3.0 text, taken from GitHub's license API (`gh api licenses/gpl-3.0`). The app's `package.json` says `GPL-3.0-only`. GPL-3.0 is compatible with python-chess (GPL-3.0) and chessground (GPL-3.0-or-later).

## 5. Card rules and the "avoid the blunder" data

- **Card rules:** unchanged.
- **"Avoid the blunder" card type:** not added.
- **Its data is kept:**
  - Every move that lost 5 Win% or more is rebuilt on every run into `data/derived/mistakes.jsonl`, with its label, evals, gap and the list of rules that excluded it (`excluded_by`).
  - That file is rebuilt from the committed analysis files, so adding the card type later needs no re-analysis.
  - The positions a second card type would use are the ones where `excluded_by` is exactly `["best_not_clearly_best"]`: 9,251 today (Phase 1 report, section 12).

## 6. The app (milestones 2.1 and 2.2)

**Open it:** https://jakeb3ckman.github.io/chess-coach/

**What it does:**
- **One card at a time:** the position before your move, your side at the bottom, the opponent's last move highlighted.
- **Moving a piece:** tap the piece, then tap the target square (legal squares are marked), or drag it.
  - Touches on the board never scroll the page.
  - Promoting a pawn shows a four-piece picker.
- **Right move:** green tick, then the engine line plays from your move. **Next** grades it Good; **Easy** grades it Easy.
- **Wrong move:** graded Again and saved straight away.
  - The board shows the engine's move as a green arrow and yours as a red arrow.
  - It says what you played in the original game and how much it lost.
  - The engine line can be stepped through (◀ ▶, or tap any move).
  - Two links: **Open the game** (Lichess games open at the move) and **Analysis board** (Lichess, at this position).
- **Daily queue:**
  - Due cards come first; a missed card comes back after 1 minute, then 10 minutes.
  - Then new cards, in the approved order (occurrences, recency, drop), at most 10 a day.
  - The day starts at 4 a.m.
  - When only missed cards are left, it says when they come back and offers "Review them now".
- **Settings (⚙︎):**
  - how many reviews are saved on this device
  - whether it is running as the Home Screen app
  - whether storage is marked persistent
  - a **Save a backup of my reviews** button (on iPhone it should open the share sheet; not yet tried on a real phone)
- **Offline:** works offline after the first load. New cards appear after each nightly run, the next time the app opens online.

**Under the hood:**
- **Scheduling:** ts-fsrs 6.0.0, fixed to FSRS-7, desired retention 0.90, learning steps 1 min / 10 min, relearning 10 min, no fuzz.
  - "No fuzz" means the same events always give the same schedule, which sync depends on.
- **Storage:** reviews and each card's current schedule are saved in the app's own on-device database.
  - The review and the card's new schedule are saved together, or not at all.
  - Every review also goes into an outbox that the sync milestone will upload, so the reviews from your trial days are not lost.
- **Downloads:**
  - The app downloads one data file, `data/cards.json`: 2,530 cards, about 200 KB compressed.
  - Total first load is about 250 KB.
  - Game and analysis files are not published. I checked on the live site that `/data/games/…`, `/data/analysis/…` and `/docs/…` all return 404.
- **noindex:** every page has `<meta name="robots" content="noindex, nofollow">` from the first deploy, including the 404 page.
  - The build fails if any HTML page lacks the tag.
  - Checked on the live site.
- **Publishing:**
  - The nightly pipeline now ends by rebuilding and publishing the app (`site` job).
  - Pushes that change the app also publish it.
  - The publish job runs the app's type check and tests first.

**Tested:**
- **Python tests:** 48 pass (3 new):
  - the card file holds only card fields
  - the previous move leads to the card's position
  - game links
  - deep-all mode
- **App tests:** 13 pass (`npm test`):
  - **Queue:** the day rolls over at 4 a.m.; 10 new cards a day in deck order; a missed card returns after 1 minute and ahead of new cards; due cards are ordered by due time.
  - **Replay:** replaying a card's events in any order gives exactly the state built review by review, and a duplicated event counts once. These are what sync relies on.
  - **All 2,530 current cards:** the solution, the engine line and the game move are all legal in chess.js.
  - **A simulated year:** 4,000 reviews over 2,530 cards; building the daily queue takes about 1 ms on the Mac (the test fails above 50 ms).
- **In the browser at iPhone size (375 × 812), on localhost and the live site:**
  - a wrong answer by tapping, the arrows, stepping through the line, the links
  - a right answer by dragging, then Next
  - reviews still there after a reload, and the counter going down
  - the settings screen
  - the promotion picker, on a real card where a pawn can promote
  - the offline service worker installing on the live site

**Not tested, or limited:**
1. **Not tried on a real iPhone.** The browser test emulates the screen size but is not iOS Safari. Thumb feel, the Home Screen install, storage persistence and the share-sheet backup still need your few days on the phone.
2. **Board edge letters:** the "h" file letter is clipped at the right edge on a 375-pixel-wide screen. This is cosmetic.
3. **First-open speed on the iPhone:** not measured. The app reads one stored record per started card on open. The 1-second target with a year of reviews (spec 6.2) is checked before the sync milestone is called done.
4. **Answering right on a brand-new card:** the card goes straight to about 5 days, rather than 10 minutes. This is FSRS-7's own rule in ts-fsrs v6, which lets the model skip a learning step when the answer shows you already know it. I kept the library's behavior rather than overriding it. A miss still goes 1 min → 10 min.

## 7. Sync design for later (2.3), already in the spec

Spec section 6.2 covers your three points:

- **Expired or revoked token:**
  - GitHub answers 401, 403 or 404. The app stops trying, keeps training, and shows: "Sync stopped: GitHub refused the token (expired or revoked). N reviews are saved on this device…".
  - Tapping the message opens the token screen.
  - Outbox reviews are deleted only after GitHub confirms the write.
  - Being offline is handled separately, as "offline, N waiting".
- **Token entered inside the installed app:**
  - It goes in the app's own Settings screen, never in a URL.
  - On iPhone, the Home Screen app's storage is separate from Safari's. The app already warns about this: in iPhone Safari it shows "Use this from your Home Screen…".
  - Each device gets its own token.
- **Opening doesn't get slower over a year:**
  - On open the app reads each card's stored schedule. It never replays the whole log, so opening reads one record per started card (at most about 2,500) however many reviews have piled up.
  - Remote files are one per device per month, about 24 a year.
  - Opening fetches the file list in one request and downloads only the files that changed.
  - Sync runs after the first card is on screen.

The parts of this that 2.2 needs are already built: the outbox, the unique event ids, the per-card stored schedule, and replay that matches review-by-review state exactly.

## 8. What to do on your iPhone (about 2 minutes)

1. Open **https://jakeb3ckman.github.io/chess-coach/** in Safari.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Open **Chess Coach** from the Home Screen icon and train from there, not from Safari. Reviews done in Safari stay in Safari.

After a few days, tell me what to change. Sync (2.3) has not been started.
