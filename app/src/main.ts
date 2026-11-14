// The trainer UI (spec section 6.1). Board: chessground. Rules: chess.js.
// Scheduling: ts-fsrs. Everything is saved on this device; sync is milestone 2.3.
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import { allEvents, getMeta, loadStates, openDb, outboxCount, saveReview, setMeta } from './db.ts';
import { buildQueue, nextCard, type Queue } from './queue.ts';
import { applyEvent, getScheduler, Rating, type CardState, type Scheduler } from './scheduler.ts';
import { inCheck, isPromotion, legalDests, lineSteps, sanOf, uciSquares, type LineStep } from './chessutil.ts';
import type { AppCard, CardsFile, ReviewEvent } from './types.ts';

declare const BUILD_ID: string;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface App {
  db: IDBDatabase;
  sched: Scheduler;
  device: string;
  cards: AppCard[];
  byId: Map<string, AppCard>;
  states: Map<string, CardState>;
  cg: Api;
  queue: Queue;
  current?: AppCard;
  shownAt: number;
  answered: boolean;
  steps: LineStep[];
  stepIdx: number; // -1 = puzzle position
  attempt?: string;
  reviewedThisSession: number;
  reviewEarly: boolean;
}

let app: App;

// ---------- start-up

async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const db = await openDb();
  let device = await getMeta<string>(db, 'device');
  if (!device) {
    const kind = /iPhone|iPad/.test(navigator.userAgent) ? 'iphone' : /Mac/.test(navigator.userAgent) ? 'mac' : 'device';
    device = `${kind}-${crypto.randomUUID().slice(0, 4)}`;
    await setMeta(db, 'device', device);
  }
  navigator.storage?.persist?.().catch(() => {});

  const [file, states, sched] = await Promise.all([
    fetch('data/cards.json').then((r) => {
      if (!r.ok) throw new Error(`cards.json: HTTP ${r.status}`);
      return r.json() as Promise<CardsFile>;
    }),
    loadStates(db),
    getScheduler(),
  ]);
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
  app = {
    db, sched, device, cg, states,
    cards: file.cards,
    byId: new Map(file.cards.map((c) => [c.id, c])),
    queue: buildQueue(file.cards, states, new Date()),
    shownAt: 0, answered: false, steps: [], stepIdx: -1,
    reviewedThisSession: 0, reviewEarly: false,
  };
  $('#menu').addEventListener('click', openSettings);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !app.current) showNext();
  });
  showInstallHint();
  showNext();
}

// ---------- queue

function refreshQueue() {
  app.queue = buildQueue(app.cards, app.states, new Date());
  const q = app.queue;
  $('#counts').innerHTML =
    `<span title="due now">Due <b>${q.due.length}</b></span>` +
    `<span title="new cards left today">New <b>${q.fresh.length}</b></span>`;
}

function showNext() {
  refreshQueue();
  let card = nextCard(app.queue);
  if (!card && app.reviewEarly && app.queue.later.length) card = app.queue.later[0].card;
  if (!card) return showEmpty();
  showCard(card);
}

function showEmpty() {
  app.current = undefined;
  app.cg.set({ viewOnly: true, movable: { color: undefined, dests: new Map() }, drawable: { autoShapes: [] } });
  const later = app.queue.later;
  let html = `<p class="big">Done for now.</p>`;
  if (app.reviewedThisSession) html += `<p>${app.reviewedThisSession} card${app.reviewedThisSession === 1 ? '' : 's'} this session.</p>`;
  if (later.length) {
    const mins = Math.max(1, Math.ceil((later[0].dueAt.getTime() - Date.now()) / 60_000));
    html += `<p>${later.length} card${later.length === 1 ? '' : 's'} you missed come${later.length === 1 ? 's' : ''} back in ${mins} min.</p>
      <div class="buttons"><button id="early" class="secondary">Review them now</button></div>`;
  } else {
    html += `<p>New cards tomorrow (after 4 a.m.).</p>`;
  }
  $('#panel').innerHTML = html;
  $('#early')?.addEventListener('click', () => { app.reviewEarly = true; showNext(); });
  // Come back automatically when the next learning card is due.
  if (later.length) setTimeout(() => { if (!app.current) showNext(); }, Math.max(5_000, later[0].dueAt.getTime() - Date.now() + 500));
}

// ---------- one card

function showCard(card: AppCard) {
  app.current = card;
  app.answered = false;
  app.attempt = undefined;
  app.steps = lineSteps(card.fen, card.line);
  app.stepIdx = -1;
  setPosition(card.fen, card.prev, true);
  app.shownAt = performance.now();
  const side = card.color === 'white' ? 'White' : 'Black';
  const n = card.occ.length;
  const isNew = !app.states.has(card.id);
  $('#panel').innerHTML = `
    <p class="big"><span class="dot ${card.color}"></span>${side} to move. Find the best move.</p>
    <p class="muted">${isNew ? 'New card' : 'Review'} · from your ${esc(card.occ[0].tc)} game, ${esc(card.occ[0].at)}${n > 1 ? ` · missed in ${n} games` : ''}</p>`;
}

function setPosition(fen: string, lastMoveUci: string | null, playable: boolean) {
  const card = app.current!;
  app.cg.set({
    fen,
    orientation: card.color,
    turnColor: fen.split(' ')[1] === 'w' ? 'white' : 'black',
    lastMove: lastMoveUci ? (uciSquares(lastMoveUci) as Key[]) : undefined,
    check: inCheck(fen),
    viewOnly: false,
    movable: playable ? { color: card.color, dests: legalDests(fen) as Map<Key, Key[]> } : { color: undefined, dests: new Map() },
    drawable: { autoShapes: [] },
  });
}

async function onMove(orig: Key, dest: Key) {
  const card = app.current;
  if (!card || app.answered) return;
  const ms = Math.round(performance.now() - app.shownAt);
  let uci = `${orig}${dest}`;
  if (isPromotion(card.fen, orig, dest)) uci += await pickPromotion(card.color);
  app.answered = true;
  app.attempt = uci;
  app.cg.set({ movable: { color: undefined, dests: new Map() } });
  const correct = uci === card.solution;
  if (correct) {
    showAnswer(true, ms);
  } else {
    await record(card, uci, false, Rating.Again, ms); // saved before anything else is shown
    showAnswer(false, ms);
  }
}

async function record(card: AppCard, move: string, correct: boolean, rating: number, ms: number) {
  const ev: ReviewEvent = {
    id: crypto.randomUUID(), v: 1, card_id: card.id, ts: new Date().toISOString(),
    device: app.device, move_played: move, correct, rating, ms_to_answer: ms,
  };
  const st = applyEvent(app.sched, app.states.get(card.id), ev);
  await saveReview(app.db, ev, st);
  app.states.set(card.id, st);
  app.reviewedThisSession++;
}

function showAnswer(correct: boolean, ms: number) {
  const card = app.current!;
  const best = sanOf(card.fen, card.solution);
  const game = card.occ[0];
  const gameSan = sanOf(card.fen, game.move);
  const attemptSan = app.attempt ? sanOf(card.fen, app.attempt) : '';
  const analysis = `https://lichess.org/analysis/standard/${card.fen.replace(/ /g, '_')}?color=${card.color}`;
  const gameNote = !correct && app.attempt === game.move ? ' (the same move as in the game)' : '';
  const lineHtml = app.steps.map((s, i) => `<button class="mv" data-i="${i}">${esc(s.label)}</button>`).join(' ');
  $('#panel').innerHTML = `
    <p class="big ${correct ? 'ok' : 'bad'}">${correct ? `✓ ${esc(best)} is the engine's move.` : `✗ You played ${esc(attemptSan)}${gameNote}. Best was <b>${esc(best)}</b>.`}</p>
    <p class="muted">In the game (${esc(game.tc)}, ${esc(game.at)}) you played ${esc(gameSan)}: ${esc(game.label)}, −${game.drop.toFixed(1)} Win%.${card.occ.length > 1 ? ` Missed in ${card.occ.length} games.` : ''}</p>
    <div class="line"><button class="step" id="prev" aria-label="Back">◀</button><div class="moves">${lineHtml}</div><button class="step" id="next" aria-label="Forward">▶</button></div>
    <p class="links"><a href="${esc(game.link)}" target="_blank" rel="noopener">Open the game ↗</a><a href="${esc(analysis)}" target="_blank" rel="noopener">Analysis board ↗</a></p>
    <div class="buttons">${correct ? '<button id="easy" class="secondary">Easy</button>' : ''}<button id="go" class="primary">Next</button></div>`;
  $('#panel').querySelectorAll<HTMLButtonElement>('.mv').forEach((b) => b.addEventListener('click', () => gotoStep(Number(b.dataset.i))));
  $('#prev').addEventListener('click', () => gotoStep(app.stepIdx - 1));
  $('#next').addEventListener('click', () => gotoStep(app.stepIdx + 1));
  const finish = async (rating: number) => {
    $('#go').setAttribute('disabled', '');
    if (correct) await record(card, app.attempt!, true, rating, ms);
    showNext();
  };
  $('#go').addEventListener('click', () => finish(Rating.Good));
  $('#easy')?.addEventListener('click', () => finish(Rating.Easy));
  if (correct) gotoStep(0);
  else gotoStep(-1);
}

function gotoStep(i: number) {
  const card = app.current!;
  i = Math.max(-1, Math.min(app.steps.length - 1, i));
  app.stepIdx = i;
  if (i === -1) {
    setPosition(card.fen, card.prev, false);
    const shapes: DrawShape[] = [{ orig: card.solution.slice(0, 2) as Key, dest: card.solution.slice(2, 4) as Key, brush: 'green' }];
    if (app.attempt && app.attempt !== card.solution) {
      shapes.push({ orig: app.attempt.slice(0, 2) as Key, dest: app.attempt.slice(2, 4) as Key, brush: 'red' });
    }
    app.cg.set({ drawable: { autoShapes: shapes } });
  } else {
    const s = app.steps[i];
    setPosition(s.fenAfter, s.uci, false);
  }
  $('#panel').querySelectorAll('.mv').forEach((b, j) => b.classList.toggle('on', j === i));
  // Scroll only the move strip sideways; scrollIntoView could move the whole page.
  const strip = $('#panel').querySelector<HTMLElement>('.moves');
  const on = $('#panel').querySelector<HTMLElement>('.mv.on');
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
  const introduced = [...app.states.keys()].filter((k) => app.byId.has(k)).length;
  dlg.innerHTML = `
    <h2>Settings</h2>
    <dl>
      <dt>Reviews saved on this device</dt><dd>${waiting} (sync to your other devices comes in the next milestone; these will be uploaded then)</dd>
      <dt>Deck</dt><dd>${app.cards.length} cards, ${introduced} started</dd>
      <dt>Home Screen app</dt><dd>${isStandalone() ? 'yes' : 'no, running in the browser'}</dd>
      <dt>Storage</dt><dd>${persisted ? 'persistent' : 'not marked persistent (iOS may clear it if the device runs low on space)'}</dd>
      <dt>Device name</dt><dd>${esc(app.device)}</dd>
      <dt>App version</dt><dd>${esc(BUILD_ID)}</dd>
    </dl>
    <div class="buttons"><button id="backup" class="secondary">Save a backup of my reviews</button><button id="close" class="primary">Close</button></div>`;
  $('#close').addEventListener('click', () => dlg.close());
  $('#backup').addEventListener('click', saveBackup);
  dlg.showModal();
}

async function saveBackup() {
  const events = await allEvents(app.db);
  const name = `chess-coach-reviews-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify({ device: app.device, events }, null, 1)], name, { type: 'application/json' });
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
