// The trainer UI (spec section 6.1). Board: chessground. Rules: chess.js.
// Scheduling: ts-fsrs (scheduler.ts). The day's set: session.ts.
// Everything is saved on this device; sync is milestone 2.3.
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import { allEvents, getMeta, loadSet, loadStates, openDb, outboxCount, replaceStates, saveAll, setMeta } from './db.ts';
import { dayKey, returnText } from './day.ts';
import { applyOutcome, counts, createSet, isComplete, type DaySet } from './session.ts';
import {
  applyEvent, getScheduler, previewDue, Rating, replayCard, scheduledToday, type CardState, type Scheduler,
} from './scheduler.ts';
import { inCheck, isPromotion, legalDests, lineSteps, sanOf, uciSquares, type LineStep } from './chessutil.ts';
import type { AppCard, CardsFile, ReviewEvent, ReviewEventV2, Status } from './types.ts';

declare const BUILD_ID: string;
declare const APP_VERSION: string;
const SCHEMA = 2;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Showing {
  card: AppCard;
  n: number; // showing number today (1 = first)
  first: boolean; // this showing feeds the long-term scheduler
  attempts: number;
  failed: boolean; // wrong move, hint or solution in this showing
  hinted: boolean;
  revealed: boolean;
  done: boolean;
  shownAt: number;
  attempt?: string; // last move tried
  lines: { best: LineStep[]; ref: LineStep[] };
  view: { line: 'best' | 'ref'; idx: number };
}

interface App {
  db: IDBDatabase;
  sched: Scheduler;
  device: string;
  cards: AppCard[];
  byId: Map<string, AppCard>;
  states: Map<string, CardState>;
  set: DaySet;
  cg: Api;
  sh?: Showing;
  reloadWhenIdle: boolean;
  setStarted: number;
}

let app: App;

// ---------- start-up, updates, migration

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (BUILD_ID === 'dev') return; // local dev server: always load the latest code
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
  // A new version took over: reload as soon as no card is in progress.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install, nothing to refresh
    if (!app || !app.sh || app.sh.done || app.sh.attempts === 0) location.reload();
    else app.reloadWhenIdle = true;
  });
}

async function start() {
  setupServiceWorker();
  const db = await openDb();
  let device = await getMeta<string>(db, 'device');
  if (!device) {
    const kind = /iPhone|iPad/.test(navigator.userAgent) ? 'iphone' : /Mac/.test(navigator.userAgent) ? 'mac' : 'device';
    device = `${kind}-${crypto.randomUUID().slice(0, 4)}`;
    await setMeta(db, 'device', device);
  }
  navigator.storage?.persist?.().catch(() => {});

  const [file, sched] = await Promise.all([
    fetch('data/cards.json').then((r) => {
      if (!r.ok) throw new Error(`cards.json: HTTP ${r.status}`);
      return r.json() as Promise<CardsFile>;
    }),
    getScheduler(),
  ]);
  const byId = new Map(file.cards.map((c) => [c.id, c]));
  let states = await loadStates(db);
  const schema = (await getMeta<number>(db, 'schema')) ?? 1;
  let migratedEvents: ReviewEvent[] = [];
  if (schema < SCHEMA) {
    // Format 1 -> 2: keep every review, recompute each card's schedule from its
    // reviews under the new rules (first answer of the day counts, 1-day / 2-day steps).
    migratedEvents = await allEvents(db);
    const byCard = new Map<string, ReviewEvent[]>();
    for (const ev of migratedEvents) byCard.set(ev.card_id, [...(byCard.get(ev.card_id) ?? []), ev]);
    const fresh: CardState[] = [];
    for (const [id, evs] of byCard) {
      const moves = new Set((byId.get(id)?.occ ?? []).map((o) => o.move));
      const st = replayCard(sched, evs, moves);
      if (st) fresh.push(st);
    }
    await replaceStates(db, fresh, [...states.values()], 'backup_schema1_states', SCHEMA);
    states = await loadStates(db);
  }

  const cg = Chessground($('#board'), {
    coordinates: true,
    blockTouchScroll: true, // dragging a piece never scrolls the page
    animation: { enabled: true, duration: 180 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: onMove } },
    draggable: { enabled: true, showGhost: true, distance: 3 },
    selectable: { enabled: true }, // tap a piece, then tap the target
    premovable: { enabled: false },
    drawable: { enabled: false, visible: true },
  });

  const now = new Date();
  const today = dayKey(now);
  let set = await loadSet(db, today);
  if (!set) {
    set = createSet(today, file.cards, states, migratedEvents, now);
    await saveAll(db, [], [], set);
  }
  app = { db, sched, device, cards: file.cards, byId, states, set, cg, reloadWhenIdle: false, setStarted: Date.now() };
  $('#menu').addEventListener('click', openSettings);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!app.sh || app.sh.done) && dayKey(new Date()) !== app.set.day) showNext();
  });
  if (BUILD_ID === 'dev') {
    // Local testing only (removed from published builds): play a move on the current card.
    (window as unknown as Record<string, unknown>).__test = { app: () => app, move: (u: string) => onMove(u.slice(0, 2) as Key, u.slice(2, 4) as Key) };
  }
  showInstallHint();
  if (set.pending_grade) await grade(set.pending_grade, Rating.Good); // app was closed before Next
  if (set.paused && !isComplete(set)) showPaused();
  else showNext();
}

// ---------- the set

async function ensureToday() {
  const now = new Date();
  const today = dayKey(now);
  if (app.set.day === today) return;
  app.set = (await loadSet(app.db, today)) ?? createSet(today, app.cards, app.states, [], now);
  await saveAll(app.db, [], [], app.set);
}

function renderCounts() {
  const c = counts(app.set);
  const chip = (s: Status, label: string) => `<span class="cnt ${s}"><b>${c[s]}</b> ${label}</span>`;
  $('#counts').innerHTML = chip('remaining', 'Remaining') + chip('missed', 'Missed') + chip('unsure', 'Unsure') + chip('known', 'Known');
}

async function showNext() {
  if (app.reloadWhenIdle) return location.reload();
  await ensureToday();
  renderCounts();
  while (app.set.order.length && !app.byId.has(app.set.order[0])) {
    // A card that left the deck (card rules changed): drop it from today's set.
    const gone = app.set.order.shift()!;
    app.set.status[gone] = 'known';
  }
  if (isComplete(app.set) || app.set.cards.length === 0) return showComplete();
  showCard(app.byId.get(app.set.order[0])!);
}

function showComplete() {
  app.sh = undefined;
  app.cg.set({ viewOnly: true, movable: { color: undefined, dests: new Map() }, drawable: { autoShapes: [] } });
  const set = app.set;
  const n = set.cards.length;
  renderCounts();
  if (n === 0) {
    banner('done', 'Nothing to review today.');
    $('#panel').innerHTML = `<p>New cards tomorrow (after 4 a.m.).</p>`;
    return;
  }
  const firstTry = set.cards.filter((id) => (set.showings[id] ?? 0) <= 1).length;
  banner('done', '✓ Set complete');
  $('#panel').innerHTML = `
    <p class="big">All ${n} cards answered correctly.</p>
    <p>${firstTry} right on the first try, ${n - firstTry} needed more than one showing.</p>
    <p class="muted">The next set is ready tomorrow after 4 a.m.</p>`;
}

function showPaused() {
  app.sh = undefined;
  renderCounts();
  app.cg.set({ viewOnly: true, movable: { color: undefined, dests: new Map() }, drawable: { autoShapes: [] } });
  banner('prompt', 'Set saved');
  $('#panel').innerHTML = `
    <p>${app.set.order.length} card${app.set.order.length === 1 ? '' : 's'} left in today's set. Your place is saved.</p>
    <div class="buttons"><button id="resume" class="primary">Resume</button></div>`;
  $('#resume').addEventListener('click', async () => {
    app.set.paused = false;
    await saveAll(app.db, [], [], app.set);
    showNext();
  });
}

async function finishLater() {
  app.set.paused = true;
  await saveAll(app.db, [], [], app.set);
  showPaused();
}

// ---------- one showing

function showCard(card: AppCard) {
  const n = (app.set.showings[card.id] ?? 0) + 1;
  const st = app.states.get(card.id);
  app.sh = {
    card, n,
    first: !scheduledToday(st, app.set.day),
    attempts: 0, failed: false, hinted: false, revealed: false, done: false,
    shownAt: performance.now(),
    lines: { best: lineSteps(card.fen, card.line), ref: refSteps(card) },
    view: { line: 'best', idx: -1 },
  };
  setPosition(card.fen, card.prev, true);
  const side = card.color === 'white' ? 'White' : 'Black';
  banner('prompt', `${side} to move. Find the best move.`);
  const status = app.set.status[card.id] ?? 'remaining';
  const where = status === 'missed' ? 'You missed this one earlier today.' : status === 'unsure' ? 'Once more to make it Known.' : (st ? 'Review' : 'New card');
  const k = card.occ.length;
  $('#panel').innerHTML = `
    <p class="muted">${where} · from your ${esc(card.occ[0].tc)} game, ${esc(card.occ[0].at)}${k > 1 ? ` · missed in ${k} games` : ''}</p>
    <div id="tools"></div>
    <p class="later"><button id="later" class="link">Finish later</button></p>`;
  $('#later').addEventListener('click', finishLater);
}

function refSteps(card: AppCard): LineStep[] {
  if (!card.game.refutation) return [];
  return lineSteps(afterGameMove(card), card.game.refutation);
}

function afterGameMove(card: AppCard): string {
  return lineSteps(card.fen, card.game.move)[0]?.fenAfter ?? card.fen;
}

function setPosition(fen: string, lastMoveUci: string | null, playable: boolean, shapes: DrawShape[] = []) {
  const card = app.sh!.card;
  app.cg.set({
    fen,
    orientation: card.color,
    turnColor: fen.split(' ')[1] === 'w' ? 'white' : 'black',
    lastMove: lastMoveUci ? (uciSquares(lastMoveUci) as Key[]) : undefined,
    check: inCheck(fen),
    viewOnly: false,
    movable: playable ? { color: card.color, dests: legalDests(fen) as Map<Key, Key[]> } : { color: undefined, dests: new Map() },
    drawable: { autoShapes: shapes },
  });
}

function banner(kind: 'prompt' | 'wrong' | 'done' | 'revealed', html: string) {
  const el = $('#banner');
  el.className = kind;
  el.innerHTML = `<span>${html}</span>`; // one flex item, so spaces around <b> survive
}

/** Build a format-2 event for the current card. */
function ev(kind: ReviewEventV2['kind'], extra: Partial<ReviewEventV2>): ReviewEventV2 {
  const sh = app.sh!;
  return {
    id: crypto.randomUUID(), v: 2, card_id: sh.card.id, ts: new Date().toISOString(), day: app.set.day,
    device: app.device, kind, showing: sh.n, sched: false, ms: Math.round(performance.now() - sh.shownAt), ...extra,
  };
}

/** Save events (and the card's new state + the set) in one transaction. */
async function commit(events: ReviewEventV2[], rating: number | null = null) {
  const sh = app.sh!;
  let st = app.states.get(sh.card.id);
  for (const e of events) st = applyEvent(app.sched, st, e, e.sched ? rating : null, !!e.habit);
  app.set.showings[sh.card.id] = sh.n;
  await saveAll(app.db, events, st ? [st] : [], app.set);
  if (st) app.states.set(sh.card.id, st);
  renderCounts();
}

/** First failure in a showing: the card becomes Missed; on the first showing of
 * the day this is the one event that tells the scheduler "Again". */
function failOnce(): { sched: boolean; status: Status } {
  const sh = app.sh!;
  if (sh.failed) return { sched: false, status: 'missed' };
  sh.failed = true;
  const status = applyOutcome(app.set, sh.card.id, false);
  return { sched: sh.first, status };
}

async function onMove(orig: Key, dest: Key) {
  const sh = app.sh;
  if (!sh || sh.done) return;
  const card = sh.card;
  let uci = `${orig}${dest}`;
  if (isPromotion(card.fen, orig, dest)) uci += await pickPromotion(card.color);
  sh.attempts++;
  sh.attempt = uci;
  if (uci === card.solution) {
    sh.done = true;
    if (!sh.failed) {
      const status = applyOutcome(app.set, card.id, true);
      const e = ev('move', { attempt: sh.attempts, move_played: uci, correct: true, status_after: status });
      if (sh.first) app.set.pending_grade = card.id; // Next / Too easy decides the rating
      await commit([e]);
    } else {
      await commit([ev('move', { attempt: sh.attempts, move_played: uci, correct: true, status_after: 'missed' })]);
    }
    return showAnswer();
  }
  // Wrong: say so, put the piece back, let me try again.
  const habit = card.occ.some((o) => o.move === uci);
  const f = failOnce();
  const e = ev('move', {
    attempt: sh.attempts, move_played: uci, correct: false, habit, status_after: f.status,
    sched: f.sched, rating: f.sched ? Rating.Again : undefined,
  });
  await commit([e], f.sched ? Rating.Again : null);
  banner('wrong', habit ? "✗ That's the move you played in the game." : '✗ Not the best move. Try again.');
  showTools();
  setTimeout(() => {
    if (app.sh === sh && !sh.done) setPosition(card.fen, card.prev, true, toolShapes());
  }, 650);
}

function toolShapes(): DrawShape[] {
  const sh = app.sh!;
  const shapes: DrawShape[] = [];
  if (sh.hinted) shapes.push({ orig: sh.card.solution.slice(0, 2) as Key, brush: 'green' });
  return shapes;
}

function showTools() {
  $('#tools').innerHTML = `<div class="buttons three">
      <button id="t-hint" class="secondary">Hint</button>
      <button id="t-sol" class="secondary">Solution</button>
      <button id="t-mine" class="secondary">My move</button></div>
    <p id="toolnote" class="muted"></p>`;
  $('#t-hint').addEventListener('click', onHint);
  $('#t-sol').addEventListener('click', onSolution);
  $('#t-mine').addEventListener('click', onMyMove);
}

async function onHint() {
  const sh = app.sh!;
  if (sh.done) return;
  const f = failOnce();
  sh.hinted = true;
  await commit([ev('hint', { status_after: f.status, sched: f.sched, rating: f.sched ? Rating.Again : undefined })], f.sched ? Rating.Again : null);
  const from = sh.card.solution.slice(0, 2);
  $('#toolnote').textContent = `Hint: the piece on ${from} moves.`;
  setPosition(sh.card.fen, sh.card.prev, true, toolShapes());
}

async function onMyMove() {
  const sh = app.sh!;
  if (sh.done) return;
  await commit([ev('mymove', {})]);
  const g = sh.card.game.move;
  $('#toolnote').textContent = `In the game you played ${sanOf(sh.card.fen, g)}.`;
  setPosition(sh.card.fen, sh.card.prev, true, [...toolShapes(), { orig: g.slice(0, 2) as Key, dest: g.slice(2, 4) as Key, brush: 'red' }]);
}

async function onSolution() {
  const sh = app.sh!;
  if (sh.done) return;
  const f = failOnce();
  sh.revealed = true;
  sh.done = true;
  await commit([ev('solution', { status_after: f.status, sched: f.sched, rating: f.sched ? Rating.Again : undefined })], f.sched ? Rating.Again : null);
  showAnswer();
}

// ---------- after the card is solved or revealed

function evalWords(e: string): string {
  if (e.startsWith('-M')) return `mated in ${e.slice(2)}`;
  if (e.startsWith('M')) return `mate in ${e.slice(1)}`;
  return e.replace('-', '−');
}

function lineChips(which: 'best' | 'ref'): string {
  return app.sh!.lines[which].map((s, i) => `<button class="mv" data-line="${which}" data-i="${i}">${esc(s.label)}</button>`).join('');
}

function showAnswer() {
  const sh = app.sh!;
  const card = sh.card;
  const best = sanOf(card.fen, card.solution);
  const g = card.game;
  const gameSan = sanOf(card.fen, g.move);
  const st = app.states.get(card.id);
  if (sh.revealed) banner('revealed', `Solution: <b>${esc(best)}</b>`);
  else if (!sh.failed) banner('done', `✓ Solved: ${esc(best)}`);
  else banner('done', `✓ Solved: ${esc(best)} <span class="sub">(counts as missed)</span>`);

  const tags = [...card.tags];
  if (st && st.habit > 0) tags.push(`habit ×${st.habit}`);
  const analysis = `https://lichess.org/analysis/standard/${card.fen.replace(/ /g, '_')}?color=${card.color}`;
  const drop = (g.win_before - g.win_after).toFixed(1);
  const ref = sh.lines.ref.length
    ? `<div class="row"><span class="what">Refutation</span><span class="ev">${esc(evalWords(g.eval))}</span></div>
       <div class="moves">${lineChips('ref')}</div>`
    : `<div class="row"><span class="what">Refutation</span><span class="muted">not computed yet</span></div>`;
  $('#panel').innerHTML = `
    <div class="row"><span class="what">Best line</span><span class="ev">${esc(evalWords(card.best_eval))}</span></div>
    <div class="moves">${lineChips('best')}</div>
    <div class="row"><span class="what">In the game you played <b>${esc(gameSan)}</b></span><span class="ev">${esc(evalWords(g.eval))}</span></div>
    ${ref}
    <p class="muted small">Evaluations in pawns from your side. Win% ${g.win_before.toFixed(1)} → ${g.win_after.toFixed(1)} (−${drop}).${card.occ.length > 1 ? ` Missed in ${card.occ.length} games.` : ''}</p>
    ${tags.length ? `<p class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
    <div class="stepper"><button class="step" id="start" aria-label="Back to the puzzle">↺</button><button class="step" id="prev" aria-label="Back">◀</button><button class="step" id="next" aria-label="Forward">▶</button></div>
    <p class="links"><a href="${esc(card.occ[0].link)}" target="_blank" rel="noopener">Open the game ↗</a><a href="${esc(analysis)}" target="_blank" rel="noopener">Analysis board ↗</a></p>
    <div class="buttons" id="grade"></div>`;
  $('#panel').querySelectorAll<HTMLButtonElement>('.mv').forEach((b) =>
    b.addEventListener('click', () => view(b.dataset.line as 'best' | 'ref', Number(b.dataset.i))));
  $('#start').addEventListener('click', () => view('best', -1));
  $('#prev').addEventListener('click', () => view(sh.view.line, sh.view.idx - 1));
  $('#next').addEventListener('click', () => view(sh.view.line, sh.view.idx + 1));
  renderGradeButtons();
  view('best', sh.revealed || sh.failed ? -1 : 0);
}

function renderGradeButtons() {
  const sh = app.sh!;
  const card = sh.card;
  const now = new Date();
  const box = $('#grade');
  if (app.set.pending_grade === card.id) {
    const st = app.states.get(card.id);
    const good = returnText(previewDue(app.sched, st, Rating.Good, now, card.id), now);
    const easy = returnText(previewDue(app.sched, st, Rating.Easy, now, card.id), now);
    box.innerHTML = `
      <button id="easy" class="secondary">Too easy<small>Next: back ${esc(easy)}</small></button>
      <button id="go" class="primary">Next<small>Next: back ${esc(good)}</small></button>`;
    $('#easy').addEventListener('click', () => grade(card.id, Rating.Easy).then(showNext));
  } else {
    const status = app.set.status[card.id];
    const st = app.states.get(card.id);
    const due = st ? returnText(st.fsrs.dueAt, now) : '';
    const cap = status === 'missed' ? `Again in a few cards, then back ${due}`
      : status === 'unsure' ? 'Once more later in this set'
      : `Known for today · back ${due}`;
    box.innerHTML = `<button id="go" class="primary">Next<small>${esc(cap)}</small></button>`;
  }
  $('#go').addEventListener('click', async () => {
    $('#go').setAttribute('disabled', '');
    if (app.set.pending_grade === card.id) await grade(card.id, Rating.Good);
    showNext();
  });
}

/** The scheduling event for a card answered right on its first showing today. */
async function grade(cardId: string, rating: number) {
  const card = app.byId.get(cardId);
  app.set.pending_grade = undefined;
  if (!card) return saveAll(app.db, [], [], app.set);
  const prevSh = app.sh;
  if (!app.sh || app.sh.card.id !== cardId) {
    // Resuming after the app was closed before Next: grade it as Good.
    app.sh = { card, n: app.set.showings[cardId] ?? 1, first: true, attempts: 1, failed: false, hinted: false,
      revealed: false, done: true, shownAt: performance.now(), lines: { best: [], ref: [] }, view: { line: 'best', idx: -1 } };
  }
  await commit([ev('grade', { sched: true, rating, status_after: app.set.status[cardId] })], rating);
  app.sh = prevSh;
}

function view(line: 'best' | 'ref', idx: number) {
  const sh = app.sh!;
  const card = sh.card;
  const steps = sh.lines[line];
  idx = Math.max(-1, Math.min(steps.length - 1, idx));
  sh.view = { line, idx };
  const arrow = (u: string, brush: string): DrawShape => ({ orig: u.slice(0, 2) as Key, dest: u.slice(2, 4) as Key, brush });
  if (idx === -1 && line === 'best') {
    const shapes = [arrow(card.solution, 'green'), arrow(card.game.move, 'red')];
    if (sh.attempt && sh.attempt !== card.solution && sh.attempt !== card.game.move) shapes.push(arrow(sh.attempt, 'yellow'));
    setPosition(card.fen, card.prev, false, shapes);
  } else if (idx === -1) {
    setPosition(afterGameMove(card), card.game.move, false, steps[0] ? [arrow(steps[0].uci, 'red')] : []);
  } else {
    setPosition(steps[idx].fenAfter, steps[idx].uci, false);
  }
  $('#panel').querySelectorAll<HTMLElement>('.mv').forEach((b) =>
    b.classList.toggle('on', b.dataset.line === line && Number(b.dataset.i) === idx));
  const on = $('#panel').querySelector<HTMLElement>('.mv.on');
  const strip = on?.parentElement;
  if (strip && on) strip.scrollLeft = on.offsetLeft - strip.offsetLeft - (strip.clientWidth - on.clientWidth) / 2;
}

function pickPromotion(color: 'white' | 'black'): Promise<string> {
  const glyph: Record<string, string> = color === 'white'
    ? { q: '♕', r: '♖', b: '♗', n: '♘' } : { q: '♛', r: '♜', b: '♝', n: '♞' };
  const box = $('#promo');
  box.innerHTML = `<div class="promo-box">${['q', 'r', 'b', 'n'].map((p) => `<button data-p="${p}">${glyph[p]}</button>`).join('')}</div>`;
  box.hidden = false;
  return new Promise((resolve) => {
    box.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
      box.hidden = true;
      resolve(b.dataset.p!);
    }));
  });
}

// ---------- settings and install hint

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

function showInstallHint() {
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  if (!ios || isStandalone()) return;
  const el = $('#hint');
  el.innerHTML = `Use this from your Home Screen: tap Share, then “Add to Home Screen”. Reviews done here in Safari stay in Safari and won’t appear in the Home Screen app. <button id="hint-x" aria-label="Dismiss">✕</button>`;
  el.hidden = false;
  $('#hint-x').addEventListener('click', () => { el.hidden = true; });
}

async function openSettings() {
  const dlg = $('#settings') as HTMLDialogElement;
  const [waiting, persisted] = await Promise.all([outboxCount(app.db), navigator.storage?.persisted?.() ?? Promise.resolve(false)]);
  const started = [...app.states.keys()].filter((k) => app.byId.has(k)).length;
  dlg.innerHTML = `
    <h2>Settings</h2>
    <dl>
      <dt>Version</dt><dd><b>${esc(APP_VERSION)}</b> (build ${esc(BUILD_ID)})</dd>
      <dt>Review events saved on this device</dt><dd>${waiting} (sync to your other devices comes in a later milestone; these will be uploaded then)</dd>
      <dt>Deck</dt><dd>${app.cards.length} cards, ${started} started</dd>
      <dt>Today's set</dt><dd>${app.set.cards.length} cards (${app.set.day})</dd>
      <dt>Home Screen app</dt><dd>${isStandalone() ? 'yes' : 'no, running in the browser'}</dd>
      <dt>Storage</dt><dd>${persisted ? 'persistent' : 'not marked persistent (iOS may clear it if the device runs low on space)'}</dd>
      <dt>Device name</dt><dd>${esc(app.device)}</dd>
    </dl>
    <div class="buttons"><button id="backup" class="secondary">Save a backup of my reviews</button><button id="close" class="primary">Close</button></div>`;
  $('#close').addEventListener('click', () => dlg.close());
  $('#backup').addEventListener('click', saveBackup);
  dlg.showModal();
}

async function saveBackup() {
  const events = await allEvents(app.db);
  const name = `chess-coach-reviews-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify({ device: app.device, version: APP_VERSION, events }, null, 1)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file] }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

start().catch((e) => {
  $('#panel').innerHTML = `<p class="bad">Could not start: ${esc(String(e?.message ?? e))}</p>`;
});
