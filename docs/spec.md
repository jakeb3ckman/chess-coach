# Personal Chess Coach — Spec (v1, for review)

Status: approved 2026-11-13 with the changes in section 8.

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
| Lichess `jbeck1026` | 64 | 127 | 64 | **255** | All have clocks. 292 correspondence + 1 vs-computer game excluded |
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

**Mistake** (derived, rebuilt every run): `game_id`, `ply`, `fen_before`, `my_move`, `best_move`, `best_line`, `win_before`, `win_after`, `drop`, `category`, `second_best_gap`, `clock_before_s`, `time_spent_s`, `time_class`, `source_pass`, `card_status` (eligible, or the rule that excluded it).

**Card** (derived): `card_id` (hash of normalized position + solution move), `fen`, `solution_uci`, `engine_line`, `deck` (`tactics` | `opening`), `occurrences[]` (mistake refs), `created_at`.

**Review event** (progress repo, append-only, one file per device per day, e.g. `log/2026-11-13-iphone.ndjson`): `card_id`, `ts`, `device`, `move_played`, `correct`, `rating` (FSRS Again/Hard/Good/Easy), `ms_to_answer`. Card schedule = replay all events through `ts-fsrs` in time order.

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

New cards are introduced in this order: **number of occurrences** (same position missed more than once comes first), then **recency**, then **drop size**. The cap is **10 new cards/day** (setting). Grading: wrong move = Again, right move = Good, optional Easy button after a correct answer. Desired retention 0.90 (FSRS default).

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

## 6. Sync between iPhone and Mac

1. Each review is saved on the device first (works offline).
2. Every ~10 reviews, when the app goes to the background, and on open, the device appends its own events to its own daily file in the progress repo.
3. On open, each device reads the other device's new files and replays all events.

Devices never write the same file, so there are no merge conflicts. If both review the same card offline, both answers count, in time order. GitHub is the source of truth, so losing the phone's local storage loses nothing.

## 7. Milestones

| # | What I build | What you can see and test |
|---|---|---|
| **1.1** | Both importers, normalization, de-dup, incremental fetch, tests | Game counts per site and time control. Run it twice: the second run fetches only new games |
| **1.2** | Stockfish passes, classifier, card rules, tests | Mistake counts per label, cards vs excluded per rule |
| **1.3** | Full backfill + `docs/phase-1-report.md` + nightly workflow | The report with 15 sample puzzles linked to the real games. **STOP 2** |
| 2.1 | Static app: one card on a board, play a move, right/wrong | Open the site on Mac and iPhone |
| 2.2 | FSRS daily queue (local only) | Daily review count; misses come back sooner |
| 2.3 | Sync through the progress repo | Review on phone, see it updated on Mac |
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

## 9. Risks and unknowns

- **Runner speed is assumed.** The time table could be off by 2×. Phase 1 measures it.
- **Lichess `since` field**: the spec doesn't say whether it filters on game start or end. The importer re-asks for one extra day and de-duplicates by game id, so it's safe either way.
- **Chess.com lag**: archives can be 12–24 h behind, so some games become cards a day later.
- **Card volume**: at your mistake rate there may be thousands of eligible cards. The new-cards/day cap keeps the daily queue manageable. The backlog may take months to see.
- **Scheduled runs pause after 60 days without repo activity** (GitHub rule). If you don't play for two months, re-enable with one click. I'll document where.
- **Repeatability**: fixed-node, single-thread search should give identical results on any machine. Phase 1 checks this by re-running a sample.
- **Licenses**: `python-chess` and chessground are GPL-3. That's fine for a personal project. A public repo means the code is GPL-3 too.
