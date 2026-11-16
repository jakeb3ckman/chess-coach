# Personal Chess Coach — Spec (v1, for review)

Status: approved 2026-11-13 with the changes in section 8; Phase 3 sections added 2026-11-15; additions of 2026-11-16 in sections 6.1 and 6.3.

## 1. What I checked before writing this

| Source | Checked | Result |
|---|---|---|
| Chess.com PubAPI (official doc page + support article) | Endpoints, fields, rate limit, caching, User-Agent | Monthly archives `/pub/player/{user}/games/{YYYY}/{MM}`; serial requests are unlimited, parallel may get 429; ETag/Last-Modified supported; data refreshes up to every 12–24 h; asks for a User-Agent with contact info |
| Lichess API (official OpenAPI spec + api-tips page) | `GET /api/games/user/{user}` params, NDJSON, limits | `since`/`until` (ms), `perfType`, `clocks`, NDJSON via `Accept: application/x-ndjson`; 20 games/s anonymous; one request at a time; wait a full minute after a 429 |
| Lichess source (`scalachess` eval.scala, `lila` Advice.scala) | Win% formula and mistake thresholds | Formula and thresholds below are copied from it |
| My real accounts (live API calls today) | Game counts | Table below |

**Real game counts in scope** (standard chess; bullet, blitz, rapid; games against people):

| Site | Bullet | Blitz | Rapid | Total | Notes |
|---|---|---|---|---|---|
| Chess.com `jakeb3ckman` | 1,267 | 855 | 850 | **2,972** | All rated, all have per-move clocks. 158 daily games excluded |
| Lichess `jbeck1026` | 64 | 127 | 64 | **255** | All have clocks. 293 games against the computer excluded: 292 correspondence (never downloaded, the API request asks only for bullet/blitz/rapid) + 1 casual rapid (downloaded, then skipped as a computer game) |
| **Both** | 1,331 | 982 | 914 | **3,227** | ~174,000 half-moves; average game 54 half-moves |

Timing matters: about 3,200 of the 3,227 games (99%) were played in 2026. October alone had 847 Chess.com games.

## 2. Architecture

```
GitHub Actions (nightly + "Run" button)          GitHub Pages (static site)
  fetch new games → Stockfish → classify    →     app reads cards/openings JSON
  commit data/ + rebuild app data                  installable on iPhone home screen
                                                          │ reviews (with token)
                                                          ▼
                                     private repo "chess-coach-progress" (review log)
```

- **Pipeline:** Python 3.12, `python-chess` (rules, PGN parsing, engine driver), native Stockfish 19 (latest release, Sep 2026). Runs on GitHub-hosted Linux runners. Never on the phone.
- **App:** TypeScript static site (PWA, works offline). Board: `@lichess-org/chessground` (Lichess's own board, good touch handling). Rules: `chess.js`. Scheduler: `ts-fsrs` (official FSRS implementation, MIT, released Oct 2026). No hand-rolled move generation or scheduling.
- **Analysis storage:** two compact JSON files per game, each written once and never rewritten:
  - `data/games/{site}/{YYYY-MM}/{id}.json` holds the imported game.
  - `data/analysis/{site}/{YYYY-MM}/{id}.json` holds the engine output.

  A game whose analysis file exists is never re-analyzed. Cards and opening tables are rebuilt from these files on every run, so changing a card threshold never needs re-analysis.
- **What the app downloads:** only `cards.json` and `openings.json`. These are built into the site folder that gets published. The per-game files are never part of the published site, so the app cannot fetch them.
- **No search indexing:** every page carries `<meta name="robots" content="noindex, nofollow">`. A `robots.txt` won't work here, because GitHub project sites live under `/{repo}/` and crawlers only read `robots.txt` at the domain root. No sitemap, and nothing links to the site.
- **Pinned versions** (exact, installed by lock files; the Stockfish download is checked against a stored SHA-256):

  | Component | Version |
  |---|---|
  | Stockfish | 19 (`sf_19` release) |
  | Python | 3.12 (exact patch in `.python-version`) |
  | `chess` (python-chess) | 1.11.2 |
  | `pytest` | exact pin in `uv.lock` |
  | `chess.js` / `@lichess-org/chessground` / `ts-fsrs` | 1.4.0 / 10.5.0 / 6.0.0 (Phase 2, pinned in `package-lock.json`) |

  The Phase 1 report prints the installed versions.

**Where I differ from the coordinator's leaning:**

1. **No separate hosted store.** Review progress goes to a second, *private* GitHub repo. The app writes to it through GitHub's API with a token that can only touch that one repo. Result: **one account total (GitHub)**, no extra service that can pause or change its free tier (Supabase's free tier, for example, pauses projects after a week without use).
2. **Make the main repo public.** Free GitHub Pages needs a public repo, and public repos get unlimited free Actions minutes on 4-core runners (private: 2,000 min/month on 2-core). What becomes public: the code and the analysis of games that are already public on Chess.com and Lichess. Review history stays private. If you want the main repo private, the fallback is Cloudflare Pages for hosting, which adds a second account.

**How others are kept from writing to review data:** the site holds no secrets and is read-only. Writes need a fine-grained GitHub token that lives only in the app's storage on your iPhone and Mac. It is scoped to the private progress repo, "Contents: read/write" only. It cannot touch the code repo, so a leaked token cannot change the pipeline. Lost phone: delete the token on github.com and make a new one (about 2 minutes).

## 3. Data model

**Game** (`data/games/...json`): `id` (`chesscom:{uuid}` / `lichess:{id}`), `url`, `site`, `ended_at`, `time_class`, `base_s`, `increment_s`, `rated`, `my_color`, `me`/`opponent` (name, rating), `result`, `termination`, `moves` (one space-separated UCI string), `clocks` (seconds left after each half-move, tenths). Opening names (ECO + name, from the CC0 `lichess-org/chess-openings` table, applied the same way to both sites) are added in Phase 3 as derived data.

**Analysis** (`data/analysis/...json`): `engine` (name, version, options, node budgets), then compact arrays instead of one object per position. Positions are rebuilt from the moves, so no FEN is stored.
- `p1`: one `[score, best_move]` per position.
- `pv1`: a short engine line, only for my moves that lost ≥5 Win%.
- `p2`: deep results for candidate moves only: MultiPV 2 lines before the move, plus the score after it.

Scores are raw engine output (`cp` or `mate`, White's view).

**Refutations** (`data/refutations/...json`, added in the Phase 2 rework, written once): for every deep-checked move of mine, Stockfish's line for the opponent from the position after my move (`after: {ply: [score, depth, pv]}`). It repeats pass 2's "after" search exactly (2M nodes, same move history, hash cleared), so its score must equal the stored `p2` "after" score; the build records any mismatch. Analysis files are never rewritten: games analyzed before this existed only get the new file. New games get both files from the same job.

**Positions** (`data/positions/{h[:2]}/{h}.json`, added in Phase 3, written once): the position pass. For every position where I am to move, within my first 15 moves, reached in at least 3 of my games: Stockfish 19, 1 thread, 16 MB hash cleared, **MultiPV 5 at 5,000,000 nodes**, searched from the position's own FEN. Plus `{h}-{uci}.json` for each move I played there at least twice that is not in the top 5 (a search restricted to that move, same budget). `h` = sha1 of the EPD. Code: `coach/positions.py`. Runs as a step of each nightly analysis shard.

**Mistake** (derived, rebuilt every run): `game_id`, `ply`, `fen_before`, `my_move`, `best_move`, `best_line`, `win_before`, `win_after`, `drop`, `category`, `second_best_gap`, `clock_before_s`, `time_spent_s`, `time_class`, `source_pass`, `card_status` (eligible, or the rule that excluded it).

**Card** (derived): `card_id` (hash of normalized position + solution move), `fen`, `solution_uci`, `engine_line`, `deck` (`tactics` | `opening`), `occurrences[]` (mistake refs), `created_at`.

**Review event** (saved on the device first; from 2.3 also in the progress repo, append-only, one file per device per month, e.g. `log/iphone-3f9a/2026-11.ndjson`). Format 2 (Phase 2 rework) logs one event per thing that happens in a showing: `id` (random, so a re-sent event is never counted twice), `v`, `card_id`, `ts`, `day` (study day, stored so replay never depends on time zone), `device`, `kind` (`move`, `hint`, `solution`, `mymove`, `grade`), `showing` (1 = first showing that day), `attempt`, `move_played`, `correct`, `habit`, `sched`, `rating`, `ms`, `status_after`. **Exactly one event per card per study day has `sched: true`: the outcome of the first showing that day.** A card's schedule = its `sched` events replayed through `ts-fsrs` in time order; everything else is drilling and is kept for later insights but never moves the schedule. Format-1 events (milestone 2.2) count the same way: the first answer per card per day is the scheduling event. Scheduler settings: FSRS-7, desired retention 0.90, learning steps 1 day and 2 days, relearning step 1 day, model override off, no fuzz, so every device computes exactly the same schedule from the same events.

## 4. Classification and puzzle rules

**Win%** (from Lichess `scalachess`): `Win% = 50 + 50 × (2 / (1 + e^(−0.00368208 × cp)) − 1)`, cp clamped to ±1000, mate = ±1000 cp. Always from my side's view.

**Drop** = Win% after the engine's best move − Win% after the move I played.

| Label | Drop (Win% points) | Same as Lichess? |
|---|---|---|
| Inaccuracy | 5 to <10 | Yes (0.1 on Lichess's −1..1 scale) |
| Mistake | 10 to <15 | Yes (0.2) |
| Blunder | ≥15 | Yes (0.3) |

All mistakes at every label are stored, in every time control. **A mistake becomes a card only if all of these pass** (all are settings in `config/settings.toml`):

| Rule | Default |
|---|---|
| Label | Mistake or Blunder (confirmed by the deep pass) |
| Best move clearly best | Best − second-best Win% ≥ **15** (deep pass, MultiPV 2). Any other move is then itself blunder-level, so "wrong" is unambiguous |
| Game not already decided | Win% before the move between **10 and 90**. Exception: from >90, a move that drops me **below 50** (throwing away a won game) counts |
| Not in severe time trouble | Clock at the start of the move ≥ **min(15 s, 10% of base time)**. 1+0 → 6 s, 2+1 → 12 s, 3+0 and slower → 15 s |
| Not a duplicate | Same normalized position (pieces, side to move, castling, real en-passant) = one card; extra occurrences are attached to it |

New cards are introduced in this order: **number of occurrences** (same position missed more than once comes first), then **recency**, then **drop size**. The cap is **10 new cards/day** (setting). Grading (first showing of the day only): any miss in that showing = Again; right on the first try = Good, or Easy if I press **Too easy**. Desired retention 0.90 (FSRS default). Resulting intervals: a new card missed comes back the next day; a new card right first time comes back in 2 days, then FSRS takes over (about 3 weeks after that); "Too easy" on a new card gives about 54 days; a known card missed comes back the next day.

### 4.1 Tags (Phase 2 rework)

Every card is tagged from stored data only: Stockfish's stored scores and lines, plus legal-move facts from python-chess. Code: `coach/tags.py`. A card carries the union of the tags of all its occurrences. Tags are shown only after the answer, so they never give the solution away.

| Tag | Exact rule |
|---|---|
| `opening` | My move is one of my first 10 moves of the game (fullmove number ≤ 10). |
| `mate` | The stored score of the engine's best line from the card position is a forced mate **for me** (mate in n, n ≥ 1). |
| `allowed mate` | The stored score after my game move is a forced mate **against me**. |
| `thrown win` | Win% before the move > 90 and Win% after my move < 50 (the same thresholds as the card rule's exception, from `settings.toml`). |
| `missed winning capture` | See below (replaced `missed capture` on 2026-11-15). |
| `hung piece` | See below. |
| `loses material` | See below (added 2026-11-15). |

**`hung piece`, precisely.** Start from the card position and count material for me minus the opponent, with standard values P 1, N 3, B 3, R 5, Q 9 (king 0). Play my game move. Take Stockfish's refutation line for the position after my move (from `data/refutations/`, the same 2M-node search whose score is stored). The tag applies only if **all** of these hold:
1. the refutation's first move captures one of my knights, bishops, rooks or queen (not a pawn, not via en passant);
2. following the refutation line from there while every move is a capture (at most 8 plies; the first non-capture ends it; a promotion counts at its new value), I end up **at least 3 points of material worse** than in the card position.

**`missed winning capture`, precisely.** Same material count and values as `hung piece`. Two sequences, both starting from the card position:
- *best side*: play the engine's best line for as long as every move is a capture (at most 8 plies). The best move itself must be a capture, otherwise the tag doesn't apply;
- *game side*: play my game move, then Stockfish's refutation line for as long as every move is a capture (at most 8 plies after my move).

The tag applies if my material after the best side is **at least 3 points higher** than after the game side. So the capture I missed would have netted at least a minor piece more than what happened after my move. A capture that is just an even trade does not qualify.

**`loses material`, precisely.** Play my game move, then **every** move of the stored refutation line (up to 10 plies, captures or not). The tag applies if I end at least **3 points** of material worse than in the card position. This catches forks and other non-capturing tactics, for example 6.Qe3?? Nxc2+ 7.Ke2 Nxe3, where the knight's check wins the queen. Limits: the line is at most 10 plies, so it can end in the middle of an exchange, and material won back after the line ends is not counted. `hung piece` is the narrower case, measured on the capture sequence only, and usually also carries `loses material`; it doesn't when the full line wins the material back.

So `hung piece` means "the engine's reply to my move takes a piece, and the capture sequence that follows leaves me down at least a minor piece". It includes moving a piece to an attacked square, leaving a piece undefended, and failing to save a piece that was already attacked. It does not include forks, pins or mating attacks whose first move isn't a capture (no material changes on the first move), or exchanges where I get the material back within the sequence. If a card has no refutation line yet, it gets no `hung piece` tag.

### 4.2 Opening leaks and leak cards (Phase 3)

Code: `coach/openings.py`; settings `[openings]` in `config/settings.toml`.
- **Leak:** a position (pieces, side to move, castling, legal en passant) where I am to move, within my first 15 moves, reached in ≥3 of my games; a move I played there ≥2 times that loses **≥5 Win%** against the best move, both scored by the position pass; Win% before between 10 and 90. Ranked by Win% lost × times played.
- **Repertoire choice:** a leak losing 5 to under 10 Win%. Reported with my results with that move next to my results with the engine's move. No card.
- **Error:** a leak losing **≥10 Win%**. Becomes a leak card (deck `opening`), one card per position covering every error move I played there, unless a tactics card already covers the position, or 5 searched moves are all within 2 Win% of the best (then the list of right answers may be incomplete).
- **Leak card answers:** right = any move within **2 Win%** of the best (all such moves are among the 5 searched lines, because the 5th is more than 2 behind); 2 to 5 Win% behind = "Playable, but there's better", counts as wrong; one of my error moves = habit; anything else = wrong. At most **3 new leak cards a day**, inside the 10 new cards. Scheduling and the review event format are unchanged.
- **Opening names:** Lichess's CC0 table (`config/chess-openings/`), last table position within the first 40 half-moves, matched by position. Groups: the variation (name before the first ",") when it has ≥10 games for that colour, else "Family (other lines)".

## 5. Analysis depth and first-import time

- **Pass 1, every position:** Stockfish, 1 thread, fixed **200,000 nodes**. Fixed nodes on one thread keeps results repeatable on any machine.
- **Pass 2, candidates only.** A candidate is any move of mine that lost ≥7 Win% in pass 1, unless I was already below 5 Win% before it. Each candidate gets MultiPV 2 on the position before the move, plus the position after it, at **2,000,000 nodes** each. Card decisions use pass 2 only.

  Time trouble and "already decided" are *not* used to choose candidates, so changing those settings later never needs re-analysis.
- Before each position the engine gets `ucinewgame`, which clears its hash. A position's result then does not depend on which positions came before it.

**Resumable backfill (no job depends on GitHub's 6-hour limit):**
1. **Import job** (one job, about 1 minute): writes any new game files and the import state (`data/state/`), then commits.
2. **Analysis jobs** (4 in parallel): job *i* takes only games where `hash(game_id) mod 4 = i`, newest first. It works in **batches of 20 games** and commits and pushes after each batch.
   - The four jobs write disjoint sets of files, so `git pull --rebase` before each push never conflicts. A push race is retried.
   - Each job stops starting new batches after **5 h**, well inside the 6-hour limit.
   - A killed job loses at most its current, uncommitted batch. The next run skips every game whose analysis file already exists.
   - A game whose analysis throws an error gets a marker in `data/analysis-failed/` and is not retried automatically. This stops the workflow from looping on one bad game. Delete the marker to retry.
3. **Build job** (one job): rebuilds mistakes, cards and app data, then publishes the site. It is the only job that writes those files.
4. **Next run:** if games are still waiting, the workflow starts itself again. This uses `workflow_dispatch`, one of the few triggers GitHub allows from inside a workflow. A concurrency group makes sure only one run happens at a time. The same workflow also runs nightly.

**Estimate for 3,227 games** (assumption, not yet measured: about 1M nodes/s per thread on a GitHub runner):

| | Pass 1 | Pass 2 | Total |
|---|---|---|---|
| Thread-hours | ~10 | ~14–24 | ~24–34 |
| Public repo, 4-core runner | | | 6–9 h; about 2–2.5 h wall-clock as 4 parallel jobs |
| Private repo, 2-core runner | | | 12–17 h; uses 720–1,020 of 2,000 free minutes |

Ongoing at your current pace (~850 games/month) is roughly a quarter of that per month. Phase 1 measures the real speed and replaces this estimate.

**Cap the first import?** No. A date cap saves almost nothing because 99% of the games are from 2026. Instead the backlog runs **newest first**, so the most recent games become cards first.

## 6. The app, and sync between iPhone and Mac

### 6.1 Trainer (milestones 2.1 and 2.2, local only; reworked 2026-11-14)

- **The board is the whole screen.** It is as wide as the screen's content area (never wider), with the safe-area insets of the Home Screen app applied, and the **same size in every state**: the screen height minus what the answer screen needs (344 px) decides it, so it is full width on every current iPhone. Everything sits in one column as wide as the board (centred on a Mac); text has 16 px side margins, the board runs edge to edge. Nothing on the page scrolls sideways. The top strip stays empty (2.4.0: the gear became the Menu tile). Directly under the board: the four set counts as coloured tiles, plus the Menu tile, (full tiles while a card is asked, one thin row on the answer screen). Below them: a banner and a short panel.
- **Moving with a thumb:** tap a piece, then tap the target square (legal targets are marked), or drag. Touches never scroll the page. Promotion shows a four-piece picker.
- **Each card:** the position before my move, my side at the bottom, the opponent's previous move highlighted.
- **The day's set** (in the style of Lotus Chess): when the app first opens on a study day it fixes that day's set: every card due before the day ends, plus new cards in the approved order up to 10 a day. The set is finished only when every card in it is Known.
  - Statuses: **Remaining**, **Missed**, **Unsure**, **Known**, shown as four counts under the board throughout.
  - Right on the first showing: Known. Wrong (or Hint, or Solution): Missed, and the card comes back **3 cards later**. Right on a later showing: Missed → Unsure (back **5 cards later**), Unsure → Known. Wrong again: back to Missed.
  - **Finish later** saves the place; reopening the app the same day offers **Resume**. (2.5.2: the board is never put in chessground's view-only mode between cards, because chessground attaches its touch handlers only when it builds the board outside that mode; see `app/src/board.ts`.) A finished set shows a "Set complete" screen.
  - **Start another set** (2.2.2): after a set is complete, the next 10 new cards plus anything due that hasn't had its first answer today. No daily limit. Before starting, the screen shows what the new cards add to the next days: (share of first answers missed recently) × 10 tomorrow, the rest in 2 days, using the last 14 days' first-try rate (50% until there are 5 answers). First answers in extra sets count for scheduling like any other.
  - **Choice of new cards** (2.5.0): when a set starts (the day's first set, until its first answer; or "Start another set"), a menu picks which new cards it takes: All (default), White, Black, or one opening group (per colour). Only new cards are filtered: every due review still comes. The 3-a-day cap on new leak cards still applies. The choice lasts for the study day and is kept on the device only (it is not an event; the set event lists the cards as before).
  - **Sets are derived from events** (2.2.2): starting a set logs a `set` event (round number and cards); statuses and queue order are rebuilt by replaying the day's events in time order (the deciding event of each showing is its first failure, else its correct move). The same events give the same set on any device, so sync can share set progress.
  - Only the first showing of a card each day feeds the scheduler (section 3). Later showings that day are drilling: logged, never moving the card further out.
- **Screen layout** (2.2.2): between the banner and the bottom, an info area takes all the space; the button area (Next, Too easy, Hint/Solution/My move) is pinned to the bottom just above the home indicator. After an answer, the best line, the game move with its evaluation and its refutation must be visible without scrolling (2.3.1: guaranteed by the fixed board size above; the board no longer shrinks after an answer).
- **Top strip** (2.2.2): iOS 26.1+/27 can draw a frosted bar over the top of a Home Screen app while reporting a top safe-area inset of 0 (WebKit bug 301994). When the page runs under the status bar (its height equals the screen height) and the reported inset is 0, all content is kept below a 62 px strip, with 34 px kept free at the bottom for the home indicator. Settings → "Space at the top" shows the measured numbers and has Automatic / Always / Never.
- **Banner:** white "White/Black to move. Find the best move."; red when wrong; green when solved.
- **Wrong move:** the banner says "Not the best move. Try again.", or "That's the move you played in the game." when my move equals a move I played from this position in any of the card's games; that showing counts as a **habit** on the card (shown as a tag, e.g. "habit ×2"). The piece goes back and I can try again. Three buttons appear: **Hint** (marks the square of the piece that moves; counts as missed), **Solution** (reveals the answer; counts as missed), **My move** (shows the move I played in the game).
- **After solving or revealing:** the engine's solution line with its evaluation, then one block for the move I played in the game and the opponent's refutation of it, which share one evaluation (pawns from my side (a mate is shown as "mate in n" / "mated in n"). Win% is shown as secondary detail. Each line can be stepped through on the board. Then the card's tags and links to the original game (Lichess links open at the move) and a Lichess analysis board.
- **Answer time** (2.5.0): no timer is shown while solving. After a clean solve (a showing whose first event is the right move, and no miss, hint or solution on that card earlier the same study day on any device; 2.5.1), the banner shows the time from the card appearing to the move, and the card's best clean time ("best 3.1 s", "new best, was 4.2 s", or "first clean solve"). Retries and hinted answers show no time and never count toward a best. Computed on the device from the `ms` field of `move` events (all synced devices); nothing new is stored.
- **Tags** (2.5.0): every card's tag row starts with "White" or "Black", the side I played.
- **Leak cards** (2.5.0): under "You usually play f3 (13×)", my results in the games where I played that move there ("2 wins, 1 draw, 10 losses").
- **Buttons after the first showing, if right first try:** **Too easy** and **Next**, each captioned with the real return date for that card ("Next: back in 2 days"). Otherwise one **Next**, captioned with what happens ("Again in a few cards, then back tomorrow", "Once more later in this set", "Known for today · back tomorrow").
- **Study day:** starts at **4:00 a.m. local time**, so a late-night session counts as the same day.
- **Updates reach the installed app on their own:** page loads go to the network first (offline: the cached copy), and when a new version takes over while the app is open it reloads at the next card boundary. Settings shows the **version number** (e.g. 2.2.1) and build id.
- **Data the app downloads:** one file, `data/cards.json`, holding only what a card needs (position, solution, engine line and score, previous move, the game move with its score and refutation line, tags, occurrences with game links). Everything else in `data/` is never published.
- **Storage:** reviews are saved in the app's own on-device database (IndexedDB) the moment they happen, together with each card's schedule and the day's set, in one transaction. The app asks iOS for persistent storage. Every review event is kept in an "outbox" from day one for sync. **Upgrades migrate, never reset:** the update from format 1 kept every event, backed up the old schedules, and recomputed each card's schedule from its events under the new rules.
- **Backup and restore** (2.2.2): Settings saves every review event to a file and restores from such a file. Restoring adds only events not already on the device (by event id), queues them for upload, and rebuilds the affected card schedules from all their events.
- **Use the home-screen app from the first day.** On iPhone, the home-screen app has storage separate from Safari, and Safari may delete a website's data after 7 days without a visit.

### 6.2 Sync (milestone 2.3, built 2026-11-15, version 2.3.0)

**Where:** a private GitHub repository (e.g. `jakeb3ckman/chess-coach-progress`). Files: `log/{device}/{YYYY-MM}.ndjson`, one review event per line (the format-2 events of section 3, including `set` events). Each device writes only its own files, so devices never conflict. GitHub is the source of truth once events are uploaded.

**One sync** (code: `app/src/sync.ts`):
1. `GET /repos/{repo}`: checks the token, that the token reaches the repo, and that the repo is **private** (a public repo is refused: nothing is uploaded).
2. `GET /repos/{repo}/git/trees/{branch}?recursive=1`: the whole file list in one request, each file with its content hash. Only the other devices' files whose hash changed since the last sync are downloaded (`git/blobs/{sha}`). Their events are merged: an event id is stored once; every card that got new events has its schedule rebuilt from all of its events.
3. Upload the outbox, per month: read this device's file (`contents` API), append the events it doesn't have, write it back with the file's sha (a stale sha is refused by GitHub, and the app re-reads and retries). Events are marked sent only after GitHub confirms the write.

**When:** on opening (after the first card is on screen), when the app goes to the background or comes back, after every 10 answers or 20 seconds after the last answer, every 2 minutes while open, and on "Sync now". A sync never blocks the board.

**Set progress across devices:** sets are derived from events (section 6.1), so the other device's answers move cards between Remaining / Missed / Unsure / Known exactly as they would locally. A device's first set of the day is provisional until its first answer: a device that syncs before answering joins the set the other device already started, instead of starting a second one. If both devices start a set offline, the two card lists are combined.

**Both devices answer the same card offline (same study day):** both answers are kept. For the long-term schedule, only the **earlier** answer of the day counts (the rule "only the first answer of the day schedules", applied across devices); the later one is drilling. For the day's set, both showings count in time order (e.g. missed on the phone, then right on the Mac → Unsure). Both devices end up with identical schedules and sets once both have synced.

**Errors:** GitHub answers 401 for an expired, revoked or mistyped token (checked against api.github.com: `401 Bad credentials`); 404 when the repository name is wrong or the token doesn't include it; 403 for a missing permission or a rate limit. The app then:
- keeps training normally; every review stays in the outbox until GitHub confirms it;
- for token or access problems, shows a red message at the top, e.g. "Sync stopped: GitHub refused the token (expired, revoked or mistyped). 3 review events are saved on this device and will upload when sync works again. Tap to enter a new token." Tapping opens Settings;
- when offline, shows nothing loud; Settings says "Offline. N waiting to upload."

**The token:** a fine-grained personal access token for that one repository, with "Contents: Read and write" only. It is entered in the app's own Settings, in the installed Home Screen app on the iPhone (whose storage is separate from Safari) and in the app on the Mac. One token per device, so revoking one doesn't stop the other. It is stored only in that app's on-device storage, never in a URL. Settings shows the last 4 characters, has "Sync now" and "Remove token".

**Opening stays fast:** opening reads each card's stored schedule and today's events (by index), never the whole log; sync runs after the first card is on screen and downloads only changed files. Measured with a simulated year (about 4,000 reviews, 2,530 schedules, 14 monthly files): first card on screen in about 75 ms on the Mac; a normal reopen makes 2 requests (repository, file list). Not yet measured on the iPhone.

### 6.3 Openings and Insights (Phase 3, version 2.4.0)

- **Navigation:** a **Menu** tile at the end of the counts row opens Train / Openings / Insights / Settings. The top strip under the status bar stays empty. Dialogs and pages open below it and scroll inside their own box.
- **Data:** `data/openings.json` and `data/insights.json`, built nightly from stored games and Stockfish output (games are public on both sites). Review data never goes into them.
- **Openings:** repertoire per colour with time-control filters. For groups with ≥60 games: score minus rating-expected score (Elo formula on the stored ratings) in blocks of 30 games, oldest first, with 95% intervals. Opponents' replies (positions with the opponent to move in the first 8 half-moves, reached ≥20 times). Opening errors and repertoire choices (4.2). A move tree of positions reached ≥3 times in my first 15 moves: my results after each move; Stockfish's top 3 where reached ≥10 times. Where I've played them at least 5 times each: my usual move side by side with the best-scoring other move and with the engine's move.
- **Insights:** each line = the statistic, the sample behind it, and a canned tip in a separate box labelled as general advice. Shown only with ≥50 games, ≥500 moves or ≥30 events behind it. Comparisons are shown only when the 95% interval of the difference excludes zero; move-level intervals come from resampling whole games. Lines that fail are listed under "Checked, no clear pattern". Blunder rates count positions with Win% before between 10 and 90. Session = games where each starts ≤15 minutes after the previous ended (start = end − clock time used). Time zone America/New_York.
- **Clock lines** (2026-11-16, `coach/clock.py`): from the clock stored after every move; time per move = clock before − clock after + increment, as a share of the starting clock. (a) pace by stage (moves 1–10 … 41+), games lost on time while winning (reached Win% ≥ 90, lost on time without first falling below 50) against games converted, per time control; (b) pace in clearly winning positions (Win% ≥ 90) against positions still in the balance (10–90), from move 11, compared inside clock bands (>50%, 20–50%, 10–20%, <10% left); (c) long thinks = one move using ≥ 10% of the starting clock, by stage; (d) winning games lost on time with against without increment, only at the same base time; (e) blunder rate in clearly winning positions with < 10% against ≥ 50% of the clock left, also checked from move 21. Same thresholds, whole-game resampling and "Checked" rules as the other lines.
- **Progress, rating lines** (2026-11-16, `coach/ratings.py`): per site and format, rated games: rating at the start date, rating now, performance rating since the start (Elo formula against the actual opponents) with a 95% interval from resampling whole games, shown from **30 games** (setting `min_games_rating`, about ±125 points). Chess.com stores ratings after each game, Lichess before it (checked on the stored games).
- **Training lines** are computed on the device from its own review log: first-try rate by week (shown from 100 first answers over 14 study days), most repeated habits (shown when 5 cards have ≥2 habit showings).

## 7. Milestones

| # | What I build | What you can see and test |
|---|---|---|
| **1.1** | Both importers, normalization, de-dup, incremental fetch, tests | Game counts per site and time control. Run it twice: the second run fetches only new games |
| **1.2** | Stockfish passes, classifier, card rules, tests | Mistake counts per label, cards vs excluded per rule |
| **1.3** | Full backfill + `docs/phase-1-report.md` + nightly workflow | The report with 15 sample puzzles linked to the real games. **STOP 2** |
| 2.1 | Static app: one card on a board, play a move, right/wrong | Open the site on Mac and iPhone |
| 2.2 | FSRS daily queue (local only) | Daily review count; misses come back sooner. **STOP: you use it on your iPhone for a few days before sync is built** |
| 2.3 | Sync through the progress repo (built 2026-11-15) | Review on phone, see it updated on Mac |
| 2.4 | Hands-off nightly run | Play a game tonight; its mistakes are cards tomorrow |
| 3.1 | Repertoire: my openings as White/Black, opponents' replies, results by line | Opening page in the app |
| 3.2 | Opening leaks: positions where I most often miss the best move, added to the deck as `opening` cards | Leak list; opening cards appear in reviews |
| 4 | Coaching notes (later) | Possible because every engine line and every review event is kept as raw data |

The Phase 1 backfill started on this Mac (765 games) and was finished by the GitHub workflow (2,462 games). Both use the same code, Stockfish build and settings, and a 30-game re-check on a GitHub runner matched the Mac output exactly (see `docs/phase-1-report.md`). All scheduled work after Phase 1 runs on GitHub.

**What you set up yourself (only GitHub):**
1. Sign in to or create a free GitHub account (before 1.3).
2. In Terminal, run `gh auth login` and click through the browser prompt. After that I create both repos, turn on Pages, and set up the workflow.
3. Phase 2: create one fine-grained token (I'll give click-by-click steps, ~3 minutes).
4. Phase 2: open the site in Safari on iPhone → Share → Add to Home Screen → paste the token once. Same on Mac.

## 8. Decisions (approved 2026-11-13)

1. **Review store:** a private GitHub repo. One account in total.
2. **Main repo:** public.
3. **"Game not already decided":** moves that throw away a winning position stay eligible (section 4 exception).
4. **"Best move clearly better":** strict. The Phase 1 report counts the "don't hang the piece" positions this drops, where several moves are fine, so a second card type can be decided later.
5. **Test fixtures:** classifier unit tests use bare numbers with no position attached. Any fixture pairing a position with an evaluation or best move comes from a real Stockfish run, with the engine version and settings stored next to it.
6. **Chess.com User-Agent:** `chess-coach-personal/1.0 (username: jakeb3ckman)`. No email.
7. **Other approved changes:**
   - Resumable batched backfill (section 5).
   - 10 new cards/day, introduced by occurrences, then recency, then drop size.
   - Compact per-game files, and the app downloads only card and opening data.
   - Pinned versions.
   - noindex on every page.

### Phase 2 decisions (approved 2026-11-14)

1. Stop after milestone 2.2 (local-only trainer with daily queue) for a few days of real use before sync.
2. Before app code: deep-check every move in a 30-game sample on GitHub and report what the pass-1 screen misses (`scripts/screen_miss_check.py`, workflow `screen-check`).
3. Lichess exclusions reconciled: 293 games against the computer (section 1 table).
4. License: GPL-3.0 (`LICENSE`).
5. Card rules unchanged. No "avoid the blunder" card type yet. Its data stays available: every mistake at every label, with its exclusion reasons, is rebuilt into `data/derived/mistakes.jsonl` on every run from the stored analysis, so that card type can be added later without re-analysis.
6. noindex on every page from the first deploy.
7. Sync designed now (section 6.2): clear message on an expired or revoked token with reviews kept queued, token entered inside the installed app, and opening time that doesn't grow with reviews.
8. On the phone the board is the whole experience; wrong answers show the engine line and a link to the original game (section 6.1).

### Phase 2 rework decisions (2026-11-14)

1. Lotus-style day sets with Remaining / Missed / Unsure / Known; only the first showing per day feeds FSRS (sections 3, 6.1).
2. Learning steps 1 day / 2 days, relearning 1 day, model override off: a new card right first time returns in 2 days, a miss the next day.
3. Retry after a wrong move with Hint / Solution / My move; habit counting when the wrong move equals a game move.
4. Solution line, game move and refutation, each with its evaluation in pawns; refutation lines from a new write-once refutation pass (section 3).
5. Tags with exact rules (section 4.1), shown only after the answer.
6. "Too easy" replaces "Easy"; both buttons show the real return date.
7. Layout: board fits the screen exactly; status bar style `black`; version number in Settings; updates reach the installed app.
8. Not in this rework: sync, multi-move puzzles, the opening report, an insights page. Their data is kept (every showing event, habit flags, timings, refutation lines).

### Phase 3 decisions (approved 2026-11-15)

1. Opening grouping by variation with ≥10 games, else pooled by family.
2. Leak rule at 5 Win%, split: 5–10 = repertoire choice (no card), ≥10 = error (leak card), applied after the position pass re-measures.
3. Position pass: write-once, MultiPV 5 at 5M nodes, positions reached ≥3 times.
4. Leak cards: right within 2 Win%, at most 3 new a day.
5. Insights: 5 lines; missed gifts shown as kept / partly given back / given back, without a comparison to other moves; speed dropped; tilt, game number and time of day checked and hidden while unclear; training on the device.
6. Menu tile, dialogs below the top strip, "Back in 2 days" captions, no half line above the buttons.
7. Score against rating over time for openings with ≥60 games, blocks of 30.

### Additions (2026-11-16, version 2.5.0)

Leak-card record, colour tag, choice of new cards, clock lines, clean-solve times, rating lines (sections 6.1 and 6.3). No new engine work, no database or event-format change.

## 9. Risks and unknowns

- **Runner speed is assumed.** The time table could be off by 2×. Phase 1 measures it.
- **Lichess `since` field**: the spec doesn't say whether it filters on game start or end. The importer re-asks for one extra day and de-duplicates by game id, so it's safe either way.
- **Chess.com lag**: archives can be 12–24 h behind, so some games become cards a day later.
- **Card volume**: at your mistake rate there may be thousands of eligible cards. The new-cards/day cap keeps the daily queue manageable. The backlog may take months to see.
- **Scheduled runs pause after 60 days without repo activity** (GitHub rule). If you don't play for two months, re-enable with one click. I'll document where.
- **Repeatability**: fixed-node, single-thread search should give identical results on any machine. Phase 1 checks this by re-running a sample.
- **Licenses**: `python-chess` and chessground are GPL-3. That's fine for a personal project. A public repo means the code is GPL-3 too.
