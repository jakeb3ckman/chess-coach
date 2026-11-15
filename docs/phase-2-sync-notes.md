# Phase 2 sync notes (trainer 2.2.2 and sync 2.3.0)

Date: 2026-11-15. Scope: Part A (trainer fixes, deployed as **2.2.2**) and Part B (sync between iPhone and Mac, deployed as **2.3.0**). Not started: the opening report, the insights page, multi-move puzzles.

**Live:** https://jakeb3ckman.github.io/chess-coach/. Settings shows **Version 2.3.0**.

**Your reviews:** they survived both updates. Each update migrates the existing data; nothing is reset (section 3).

## 1. Summary

| # | Request | Result |
|---|---|---|
| A1 | More than one set a day, with a forecast | Built: "Start another set" after a set is complete (next 10 new + anything due), no daily limit, with a forecast shown before you start |
| A2 | Use the full screen; Next pinned at the bottom | Built. At 393×852 with the iPhone's top and bottom space applied, the best line, your move with its evaluation and the refutation fit above the pinned button without scrolling or shrinking the board |
| A3 | Merge "In the game you played" and "Refutation" | One block: "You played Qe3, refuted by … −9.65" |
| A4 | Blurred top bar | Researched first (section 2.4). Your hypothesis (b) fits: iOS 27.2 draws a frosted strip over the page while reporting a top inset of 0. The fix keeps all content below that strip and needs no reinstall. Not yet confirmed on your phone |
| A5 | File letters on top of pieces | Small, lowercase, tucked into the corner |
| A6 | Restore from backup | Built and tested: wipe the device, restore, and every schedule and today's set come back identical |
| A7 | New tags | `missed winning capture` replaces `missed capture`; `loses material` added; exact rules in spec 4.1 |
| B | Sync between iPhone and Mac | Built as designed in spec 6.2, tested with two separate browser profiles against a local stand-in for GitHub, and checked against the real GitHub API for access, errors and browser access. **Not yet run against your real progress repository**: that needs the one-time setup in section 4 |

## 2. Part A: trainer fixes

### 2.1 More than one set a day
- **When it appears:** after a set is complete, the screen offers **Start another set**: the next 10 new cards, plus anything due that hasn't had its first answer today. There is no daily limit.
- **The forecast,** shown before you start, for example: "Another set: 10 new cards. The new cards add about 2 reviews tomorrow and 8 the day after (a miss comes back tomorrow, a right first answer in 2 days; based on your first-try rate of 80% over the last 14 days)."
  - It uses the share of your first answers that were right over the last 14 study days, or 50% until there are 5 answers.
  - It is an estimate, and says so.
- **Scheduling:** first answers in extra sets schedule like any other.
- **How sets are now stored:** each set is rebuilt from the review log. Starting a set logs a `set` event; statuses and queue order are rebuilt by replaying the day's events in time order. This is what lets sync share set progress (Part B).
- **Tested:** in the browser, set 2 contained 10 new cards that weren't in set 1.

### 2.2 Using the full screen
- **Layout:** between the banner and the bottom there is one info area. The buttons (Next / Too easy / Hint · Solution · My move / Finish later) are pinned to the bottom, just above the home indicator.
- **Measured at 393×852,** with the iPhone's 62 px top and 34 px bottom space applied:
  - the important lines end at y = 734, and the button area starts at y = 749;
  - so the best line, your move with its evaluation, and the refutation are all visible with no scrolling;
  - the board stayed at full width (393 px).
- **If the lines still don't fit** (a long line on a small screen), the board shrinks a little, never below 260 px, rather than hiding lines.
- **Below the fold:** tags, ↺ ◀ ▶ and the links.

### 2.3 One block for your move and its refutation
- **Now:** "You played **Qe3**, refuted by −9.65", followed by the refutation moves.
- **Above it:** "Best line +1.53" with its moves.
- **The evaluation:** appears once.

### 2.4 Blurred top bar: research first, then the fix
What I read:
- **[WebKit bug 301994](https://bugs.webkit.org/show_bug.cgi?id=301994)** (reopened, last report on iOS 27.2):
  - "A translucent, frosted system bar overlays the upper part of the application."
  - Another report measures the top inset (the screen-edge space iOS tells the page to leave) at 0, while about 62 px are covered.
  - This matches your hypothesis (b).
- **[Bug 317153](https://bugs.webkit.org/show_bug.cgi?id=317153):** a WebKit engineer says `black-translucent` "has been deprecated", and asks people to remove that key.
- **[Bug 316008](https://bugs.webkit.org/show_bug.cgi?id=316008)** and others: report that the style is read only when the app is added to the Home Screen. That is your hypothesis (a). No Apple engineer confirms it.
- **Apple's [Configuring Web Applications](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html)** page dates from 2016 and says nothing about when the style takes effect.

What I changed (no reinstall needed):
- **Detection:** when the app runs from the Home Screen, the page height equals the screen height (it runs under the status bar), and iOS reports a top inset of 0, the app keeps all content below a **62 px** strip and **34 px** above the bottom.
- **Settings → "Space at the top":**
  - shows the measured numbers (page size, screen size, reported insets, and what's being used);
  - has **Automatic / Always / Never**, so you can override the detection.

**Limits:** I couldn't confirm this on iOS 27.2.1 (section 6). If the bar is still blurred, open Settings and send me the numbers shown under "Space at the top".

### 2.5 File letters
- **Now:** 9 px, lowercase, in the bottom-right corner of the bottom row's squares, matching the rank numbers in the top-left corners.

### 2.6 Restore from backup
- **Where:** Settings → **Restore from backup** opens a saved backup file.
- **What it does:**
  - adds only events not already on the device (by event id), and queues them for upload;
  - rebuilds every affected card's schedule from all its events.
- **Tested:** I exported 26 events, wiped the device and restored them. All 10 card schedules and today's set (round, order, statuses) came back identical.
- **Speed:** restoring 3,960 events took 0.5 s on the Mac.

### 2.7 Tags

The exact rules are in spec 4.1; the code is in `coach/tags.py`.
- **`missed winning capture`:** the engine's best move is a capture, and following its line while every move is a capture leaves me at least 3 points of material better off than my game move did (my move, then the refutation's capture sequence).
- **`loses material`:** after my game move and the whole stored refutation line (up to 10 plies, captures or not), I am at least 3 points worse than before my move.
  - It catches forks: the Qe3 card (6.Qe3?? Nxc2+ 7.Ke2 Nxe3) now has it.

**Counts** (2,530 cards):

| tag | cards | share |
|---|---|---|
| opening | 697 | 27.5% |
| mate | 68 | 2.7% |
| allowed mate | 162 | 6.4% |
| thrown win | 493 | 19.5% |
| missed winning capture | 706 | 27.9% |
| hung piece | 467 | 18.5% |
| loses material | 689 | 27.2% |
| **no tag** | **767** | **30.3%** |

**How the new tags relate to the old ones:**
- `missed winning capture` is on 706 cards; the old `missed capture` was on 1,294.
- **`hung piece` and `loses material`:** 402 of the 467 hung-piece cards also have `loses material`.
  - The other 65 lose the piece in the capture sequence but get material back later in the 10-move line.
  - So "hung piece" is not strictly a subset under the rules as written.
- **Line cut-offs:** in 18 `loses material` cards the stored line ends with an opponent capture, so the count may stop in the middle of an exchange.

**5 examples per new tag** (picked by a fixed hash; the FEN and game link let you check each one):

#### missed winning capture (706 cards)

- **3f94927433c8** · bullet · 2026-09-02 · I played black, move 7
  - FEN: `rn1qk2r/ppp1ppbp/6p1/3p1b2/4PP2/1P2PN2/PBP3PP/RN1QKB1R b KQkq - 0 7`
  - Game: https://www.chess.com/game/live/173884480558 · board: https://lichess.org/analysis/standard/rn1qk2r/ppp1ppbp/6p1/3p1b2/4PP2/1P2PN2/PBP3PP/RN1QKB1R_b_KQkq_-_0_7
  - Best: 7...Bxb2 8.exf5 Bxa1 9.c3 Qd6 10.Qc1 Qf6 11.Be2 Nd7 12.O-O (+0.64) · I played: Bxe4 (-9.48) · refutation: 8.Bxg7 Rg8 9.Bb2 Nc6 10.Bb5 Qd6 11.O-O O-O-O 12.Bd3 d4
  - Win% 55.9 → 3.0 · the engine's capture sequence leaves me 7 points better off than my move's
- **33af0b954696** · bullet · 2026-08-30 · I played black, move 13
  - FEN: `r1bq1rk1/ppp1B1pp/4p3/3pnp2/3P4/2PB1N2/P1P2PPP/R2Q1RK1 b - - 0 13`
  - Game: https://www.chess.com/game/live/173746960468 · board: https://lichess.org/analysis/standard/r1bq1rk1/ppp1B1pp/4p3/3pnp2/3P4/2PB1N2/P1P2PPP/R2Q1RK1_b_-_-_0_13
  - Best: 13...Nxf3+ 14.Qxf3 Qxe7 15.c4 c6 16.Rfe1 Qb4 17.Rab1 Qc3 18.cxd5 (+0.09) · I played: Qxe7 (-6.83) · refutation: 14.Nxe5 c5 15.Qc1 f4 16.Qd1 g6 17.Qf3 cxd4 18.cxd4 b6
  - Win% 50.8 → 7.5 · the engine's capture sequence leaves me 3 points better off than my move's
- **57b55d482a82** · blitz · 2026-09-30 · I played white, move 6
  - FEN: `rnbqkb1r/ppppp2p/6p1/5p2/3P1B2/5N2/PPPQPnPP/RN2KBR1 w Qkq - 0 6`
  - Game: https://www.chess.com/game/live/184600530044 · board: https://lichess.org/analysis/standard/rnbqkb1r/ppppp2p/6p1/5p2/3P1B2/5N2/PPPQPnPP/RN2KBR1_w_Qkq_-_0_6
  - Best: 6.Kxf2 d6 7.Nc3 Bg7 8.Bh6 O-O 9.Ke1 c6 10.e4 fxe4 (+6.09) · I played: Qe3 (-0.52) · refutation: 6...Ng4 7.Qb3 c6 8.e4 fxe4 9.Ne5 d5 10.Nxg4 Bxg4 11.Be5
  - Win% 90.4 → 45.2 · the engine's capture sequence leaves me 3 points better off than my move's
- **3ba597ad4b47** · bullet · 2026-10-29 · I played white, move 9
  - FEN: `rnbqk2r/p1pp1p1p/6pQ/1p3n2/3N4/8/PPP1PPPP/R1B1KB1R w KQkq - 1 9`
  - Game: https://www.chess.com/game/live/186148417410 · board: https://lichess.org/analysis/standard/rnbqk2r/p1pp1p1p/6pQ/1p3n2/3N4/8/PPP1PPPP/R1B1KB1R_w_KQkq_-_1_9
  - Best: 9.Nxf5 d6 10.Qe3+ Kd7 11.Nd4 Bb7 12.Qh3+ f5 13.Nxb5 Qf6 (+8.24) · I played: Qg7 (-8.93) · refutation: 9...Nxg7 10.Bh6 O-O 11.h4 d5 12.h5 c6 13.O-O-O Nxh5 14.e4
  - Win% 95.4 → 3.6 · the engine's capture sequence leaves me 12 points better off than my move's
- **1ea63ea6555e** · blitz · 2026-08-01 · I played black, move 23
  - FEN: `2kr3r/pp4p1/3bpq1p/1B1p4/5PQ1/2NP4/PPn4P/R1BK1R2 b - - 1 23`
  - Game: https://www.chess.com/game/live/172364240884 · board: https://lichess.org/analysis/standard/2kr3r/pp4p1/3bpq1p/1B1p4/5PQ1/2NP4/PPn4P/R1BK1R2_b_-_-_1_23
  - Best: 23...Nxa1 24.Nxd5 Qd4 25.Qxe6+ Kb8 26.Nc3 Bc5 27.Qe5+ Qxe5 28.fxe5 (+0.10) · I played: Ne3+ (-7.90) · refutation: 24.Bxe3 a6 25.Ba4 Rhf8 26.Bb3 g5 27.Bb6 Rd7 28.Ne2 Bc7
  - Win% 50.9 → 5.2 · the engine's capture sequence leaves me 7 points better off than my move's

#### loses material (689 cards)

- **626b68f489c1** · blitz · 2026-09-09 · I played white, move 22
  - FEN: `r3k3/1pB2p2/p3p3/3p3p/2nP1Pq1/2P1P3/P1P3KP/R1Q1R3 w q - 1 22`
  - Game: https://www.chess.com/game/live/174216954416 · board: https://lichess.org/analysis/standard/r3k3/1pB2p2/p3p3/3p3p/2nP1Pq1/2P1P3/P1P3KP/R1Q1R3_w_q_-_1_22
  - Best: 22.Kf2 Qh4+ 23.Kg2 Qg4+ (+0.00) · I played: Kf1 (-M5) · refutation: 22...Qf3+ 23.Kg1 Kd7 24.Bd8 Rxd8 25.Qd2 Rg8+ 26.Qg2 Qxg2#
  - Win% 50.0 → 2.5 · material lost by the end of the refutation line: 12
- **9340b216eb3e** · blitz · 2026-03-11 · I played black, move 28
  - FEN: `r5k1/2R4p/ppB1b1p1/3Pp3/4P3/N3K3/PP4rP/8 b - - 1 28`
  - Game: https://lichess.org/uPICBqgh/black#55 · board: https://lichess.org/analysis/standard/r5k1/2R4p/ppB1b1p1/3Pp3/4P3/N3K3/PP4rP/8_b_-_-_1_28
  - Best: 28...Rc8 29.Re7 (-1.23) · I played: Rf8 (-7.17) · refutation: 29.dxe6 Rgf2 30.Kd3 b5 31.Nc2 Rd8+ 32.Bd5 Re8 33.Ne3 Kf8
  - Win% 38.9 → 6.7 · material lost by the end of the refutation line: 3
- **a9e5a0fdb862** · blitz · 2026-08-07 · I played white, move 15
  - FEN: `B3k2r/p4ppp/4pn2/1p6/1B2q1b1/6P1/PP3P1P/RN2K2R w KQk - 1 15`
  - Game: https://lichess.org/BoqIIXXt/white#28 · board: https://lichess.org/analysis/standard/B3k2r/p4ppp/4pn2/1p6/1B2q1b1/6P1/PP3P1P/RN2K2R_w_KQk_-_1_15
  - Best: 15.Bxe4 Nxe4 16.O-O Bf3 17.Re1 Ng5 18.Nd2 h5 19.h4 Bd5 (+7.44) · I played: Kf1 (-M4) · refutation: 15...Bh3+ 16.Kg1 Qxa8 17.f3 Qxf3 18.a3 Qg2#
  - Win% 93.9 → 2.5 · material lost by the end of the refutation line: 4
- **582e735db4b7** · blitz · 2026-07-28 · I played white, move 48
  - FEN: `8/8/k7/7p/1K1p2p1/8/6PP/8 w - - 0 48`
  - Game: https://www.chess.com/game/live/172194779914 · board: https://lichess.org/analysis/standard/8/8/k7/7p/1K1p2p1/8/6PP/8_w_-_-_0_48
  - Best: 48.Kc4 Kb6 49.Kxd4 h4 50.Ke4 g3 51.hxg3 hxg3 52.Kf4 Kc7 (+6.05) · I played: Kc5 (-M14) · refutation: 48...d3 49.Kd4 d2 50.Ke3 d1=Q 51.Kf4 Qd6+ 52.Ke3 Qe5+ 53.Kf2
  - Win% 90.3 → 2.5 · material lost by the end of the refutation line: 8
- **5247be9dbebd** · bullet · 2026-09-05 · I played black, move 18
  - FEN: `r5nr/pp1k1ppp/4p3/3pP3/4n3/P1N2N2/1P3PPP/3R1RK1 b - - 1 18`
  - Game: https://www.chess.com/game/live/174043914296 · board: https://lichess.org/analysis/standard/r5nr/pp1k1ppp/4p3/3pP3/4n3/P1N2N2/1P3PPP/3R1RK1_b_-_-_1_18
  - Best: 18...Nxc3 19.bxc3 Rc8 20.Nd4 Ne7 21.Rb1 b6 22.Nb5 Ra8 23.Rfd1 (+2.56) · I played: Ne7 (-5.60) · refutation: 19.Nxe4 Rhc8 20.Nd6 Rc2 21.b4 Rc3 22.Nxb7 Rxa3 23.Nc5+ Ke8
  - Win% 72.0 → 11.3 · material lost by the end of the refutation line: 3

## 3. Your reviews survive every update

- **2.2.1 → 2.2.2:**
  - The database gains two lookups: events by card and events by day.
  - Today's stored set is written as a `set` event, so the same set continues.
  - **Tested:** I built 2.2.1 from git, answered three cards in it (two right, one missed), then opened 2.2.2 on the same storage. Statuses (Known, Missed, Known), queue order and the current card were identical.
- **2.2.2 → 2.3.0:** no data change; sync is off until you enter a token.
- **On first sync:** every review already on the phone uploads. In the test, 27 events went up in one write.

## 4. One-time setup (about 10 minutes)

Do the iPhone first, so its reviews upload before the Mac joins.

**A. Create the private progress repository (on a computer or phone, signed in to github.com)**
1. Click the **+** at the top right, then **New repository**.
2. Owner: **jakeb3ckman**. Repository name: **chess-coach-progress**.
3. Choose **Private**.
4. Turn on the option to **add a README**. This gives the repository a first commit.
5. Click **Create repository**.

**B. Create a token for the iPhone**
1. Click your profile picture (top right), then **Settings**.
2. In the left sidebar, at the very bottom, click **Developer settings**.
3. Click **Personal access tokens**, then **Fine-grained tokens**, then **Generate new token**.
4. Token name: **Chess Coach iPhone**. Expiration: pick 1 year, or a custom date up to a year away. When it expires, the app tells you and keeps your reviews until you enter a new one.
5. Resource owner: **jakeb3ckman**.
6. Repository access: **Only select repositories**, then choose **chess-coach-progress**.
7. Under **Permissions → Repository permissions**, set **Contents** to **Read and write**. Leave everything else as it is. GitHub adds "Metadata: Read-only" by itself.
8. Click **Generate token**, then copy it. GitHub shows it only once.

The easiest way to get it onto the phone: do steps B1–B8 in Safari on the iPhone itself. Or copy it on the Mac and paste on the iPhone (Universal Clipboard, same Apple ID). Don't email or message the token.

**C. Turn on sync on the iPhone**
1. Open **Chess Coach** from the Home Screen. Tap ⚙︎ and check it says **Version 2.3.0**. If not, swipe the app away and reopen it.
2. In **Sync with your other devices**, the repository already reads **jakeb3ckman/chess-coach-progress**. Paste the token into **Token**.
3. Tap **Turn on sync**. It should say "Last synced … 0 waiting to upload". Your reviews are now on GitHub.

**D. The Mac**
1. Make a second token named **Chess Coach Mac**, repeating B1–B8. Separate tokens mean revoking one doesn't stop the other.
2. On the Mac, open **https://jakeb3ckman.github.io/chess-coach/** in Safari. To make it its own app, use **File → Add to Dock**; that app keeps its own storage, so always use the same one.
3. **Before answering anything**, tap ⚙︎, paste the Mac token, and tap **Turn on sync**. The Mac then joins the set you started on the phone.

## 5. What I tested with two separate browser profiles

**Setup:**
- Two origins (`localhost:8000` and `127.0.0.1:8000`), which have completely separate storage, so they behave as two devices: "iPhone" and "Mac".
- A local stand-in for the GitHub API (`app/tools/mock_github.py`) with a test token.
- **Why a stand-in:** I didn't use a real GitHub token, because entering your real credentials into a test page isn't something I'll do. It mimics the behaviour I checked directly against api.github.com:
  - `401 Bad credentials` for a bad token;
  - `404` for an unknown repository;
  - the browser preflight allowing the headers the app sends;
  - base64 file contents, and file sha checks on write.

| test | result |
|---|---|
| First sync on the "iPhone" (27 existing events) | All 27 uploaded in one write; 0 left waiting |
| Fresh "Mac" turns on sync | Pulled the phone's events: same 10 schedules, joined the phone's current set (set 2) |
| Fresh "Mac" opened before sync was on (after the fix in spec 6.2) | Stored nothing until the first answer; after turning on sync it joined the phone's set with the same counts |
| Answers on the Mac, then open the iPhone | Switching to the iPhone synced it automatically; identical counts (8 / 1 / 0 / 1), identical queue; the card answered on the Mac moved off the iPhone's screen |
| Both offline, same card: iPhone missed it, Mac got it right | Each device kept training and showed "Offline. N waiting" (no alarm). After both synced: the schedule followed the earlier answer (the iPhone's miss, due tomorrow); the set shows the card as Unsure (missed, then right). Both devices ended with **byte-identical** schedules and sets (same fingerprint) |
| Token revoked | Red message at the top: "Sync stopped: GitHub refused the token (expired, revoked or mistyped). 2 review events are saved on this device…". Training continued. Tapping it opened Settings; a new token uploaded both events and cleared the message |
| Repository made public | Refused with a clear message; **0 writes** to the public repository |
| Wrong repository name | "The token can't reach …" message; fixing the name fixed it |
| A simulated year (3,960 reviews over 12 months, 2,530 schedules, 14 monthly files) | Reopening the Mac: first card in 73–76 ms (67 ms before the year). iPhone's first pull of the year: first card in 59 ms, with sync done in the background by 1.4 s. A normal reopen: **2 requests** (repository, file list), first card in 64 ms |
| Real api.github.com from the live app (made-up invalid token) | The browser reached GitHub; it answered 401, and the app showed the "refused the token" message; Remove token cleared it |

**Tests:**
- 26 app tests pass, 5 of them new: sync encoding and parsing, error messages, the two-devices-same-day rule, and event-built sets for two devices.
- 56 Python tests pass.

## 6. What I couldn't test without your phone

1. **A real write to your GitHub repository.** That needs the repository and token from section 4.
   - Everything up to the write was checked against the real API: reaching GitHub, the browser preflight, 401 and 404.
   - The write itself was tested only against the stand-in.
   - If the first real sync fails, nothing is lost: reviews stay queued, and the message says why.
2. **The top-strip fix on iOS 27.2.1.** It depends on what iOS reports there. Settings shows the numbers; send them if the bar still looks blurred.
3. **Syncing when you leave the app.** iOS may suspend the app before that upload finishes. Then it simply uploads on the next open or within 20 seconds of the next answer.
4. **Speed on the iPhone itself.** The 60–76 ms figures are from a Mac. Expect a few times that on a phone, still well under a second.
5. **The Mac "Add to Dock" app, and pasting the token** on the iPhone.

## 7. Things I'd flag

1. **The offline same-card rule changed.** The earlier spec said "both answers count". With your rule that only the first answer each day schedules, I made the earlier answer of the two count and the later one drilling. Otherwise a card answered on both devices would get two scheduling answers in one day.
2. **"Start another set" has no limit,** as you asked. Each extra set adds about 10 reviews over the next two days, and more later. The forecast shows the next two days only.
3. **The token sits in the app's storage on each device.** Anyone holding your unlocked phone could use it, but it reaches only the progress repository. Revoke it on GitHub if the phone is lost (about 2 minutes); the other device keeps working.
4. **Two tag edge cases** (section 2.7): 65 hung-piece cards without `loses material`, and 18 lines that end mid-exchange. Both follow the rules as written. Extending the lines would mean storing longer engine lines.

Sync is built; this round stops here.
