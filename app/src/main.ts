// The trainer UI (spec section 6.1). Board: chessground. Rules: chess.js.
// Scheduling: ts-fsrs (scheduler.ts). The day's sets: session.ts (derived from events).
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import {
  allEvents, eventsForDay, getMeta, loadLegacySet, loadStates, openDb, outboxCount, replaceStates, saveAll, setMeta,
} from './db.ts';
import { dayKey, returnText } from './day.ts';
import {
  chooseSetCards, counts, deriveSet, EXTRA_SET_NEW, extraSetForecast, isComplete, isSetEvent, NEW_PER_DAY,
  newStartedToday, newStartedTodayIn, nextStatus, type DaySet,
} from './session.ts';
import { DEFAULT_RULES, judge, rightMoves } from './leak.ts';
import { openPage, closePage } from './pages.ts';
import {
  applyEvent, getScheduler, previewDue, Rating, replayCard, scheduledToday, type CardState, type Scheduler,
} from './scheduler.ts';
import { inCheck, isPromotion, legalDests, lineSteps, sanOf, uciSquares, type LineStep } from './chessutil.ts';
import { cleanEvents, mergeEvents, type MergeResult } from './ledger.ts';
import { DEFAULT_API, Sync, type SyncStatus } from './sync.ts';
import type { AppCard, CardsFile, OpeningRules, ReviewEvent, ReviewEventV2, Status } from './types.ts';

declare const BUILD_ID: string;
declare const APP_VERSION: string;
const SCHEMA = 3;

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
  rules: OpeningRules; // leak cards (Phase 3)
  openingIds: Set<string>; // ids of leak cards
  states: Map<string, CardState>;
  today: string;
  dayEvents: ReviewEvent[]; // every event of the current study day (all devices)
  set: DaySet;
  cg: Api;
  sh?: Showing;
  reloadWhenIdle: boolean;
  // The day's first set is only written to the log with the first answer. Until
  // then it is provisional, so a device that turns on sync before answering
  // anything simply joins the set the other device already started.
  pendingSet?: ReviewEventV2;
}

let app: App;
let sync: Sync;

// ---------- screen edges (top strip under the status bar, home indicator)

interface SafeArea { envTop: number; envBottom: number; full: boolean; standalone: boolean; mode: string; top: number; bottom: number }
let safeArea: SafeArea;

/**
 * iOS 26.1+ / 27 can draw a frosted system bar over the top of a Home Screen app
 * while reporting a top safe-area inset of 0 (WebKit bug 301994). Text under that
 * strip is blurred. When the page runs under the status bar (its height equals
 * the screen height) but the reported inset is 0, keep all content below a 62 px
 * strip and above a 34 px home-indicator area. Settings can force this on or off.
 */
function applySafeArea() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const envTop = parseFloat(cs.paddingTop) || 0;
  const envBottom = parseFloat(cs.paddingBottom) || 0;
  probe.remove();
  const standalone = isStandalone();
  // The layout viewport, which page zoom doesn't change (innerWidth/innerHeight do).
  const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
  const portrait = h >= w;
  const screenH = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const full = standalone && Math.abs(h - screenH) <= 2;
  let mode = 'auto';
  try { mode = localStorage.getItem('topSpace') ?? 'auto'; } catch { /* private mode */ }
  const fix = mode === 'on' || (mode === 'auto' && full && envTop < 20);
  const top = fix ? Math.max(envTop, 62) : envTop;
  const bottom = fix && envBottom < 10 ? 34 : envBottom;
  document.documentElement.style.setProperty('--top-pad', `${top}px`);
  document.documentElement.style.setProperty('--bottom-pad', `${bottom}px`);
  safeArea = { envTop, envBottom, full, standalone, mode, top, bottom };
}

/**
 * iOS zooms the whole page in when a text box with text under 16px is tapped,
 * and a Home Screen app keeps that zoom (also across reloads). 2.3.0's token box
 * had 15px text, so after entering the token the page sat zoomed in by 16/15:
 * 377 of 402 points visible, edges cut off. Inputs are now 16px and the viewport
 * has maximum-scale=1; this also undoes a zoom that is still in place.
 */
function resetZoom() {
  const vv = window.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) < 0.01) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name=viewport]');
  if (!meta) return;
  const c = meta.content;
  // Changing the viewport rule makes WebKit re-apply it, which clamps the zoom to 1.
  meta.content = 'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, viewport-fit=cover';
  setTimeout(() => { meta.content = c; }, 400);
}

function zoomText(): string {
  const vv = window.visualViewport;
  return vv ? `${vv.scale.toFixed(3)}${Math.abs(vv.scale - 1) >= 0.01 ? ' (zoomed in!)' : ''}` : 'unknown';
}

function rectText(sel: string): string {
  const el = document.querySelector(sel);
  if (!el) return 'not on screen';
  const r = el.getBoundingClientRect();
  return `x ${Math.round(r.left)}–${Math.round(r.right)}, y ${Math.round(r.top)}–${Math.round(r.bottom)}`;
}

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

async function migrate(db: IDBDatabase, sched: Scheduler, byId: Map<string, AppCard>, device: string): Promise<void> {
  const schema = (await getMeta<number>(db, 'schema')) ?? 1;
  if (schema < 2) {
    // Format 1 -> 2: keep every review, recompute each card's schedule from its
    // reviews under the new rules (first answer of the day counts, 1-day / 2-day steps).
    const events = await allEvents(db);
    const byCard = new Map<string, ReviewEvent[]>();
    for (const ev of events) byCard.set(ev.card_id, [...(byCard.get(ev.card_id) ?? []), ev]);
    const fresh: CardState[] = [];
    for (const [id, evs] of byCard) {
      const st = replayCard(sched, evs, new Set((byId.get(id)?.occ ?? []).map((o) => o.move)));
      if (st) fresh.push(st);
    }
    await replaceStates(db, fresh, [...(await loadStates(db)).values()], 'backup_schema1_states', 2);
  }
  if (schema < 3) {
    // Schema 2 -> 3: sets become events. Today's stored set (if any) is written as
    // a 'set' event so the same set continues, and so sync can share it later.
    const today = dayKey(new Date());
    const legacy = await loadLegacySet(db, today);
    const evs = await eventsForDay(db, today);
    if (legacy && legacy.cards.length && !evs.some(isSetEvent)) {
      const e: ReviewEventV2 = {
        id: crypto.randomUUID(), v: 2, card_id: '', ts: legacy.created_at, day: today, device,
        kind: 'set', showing: 0, sched: false, round: 1, cards: legacy.cards,
      };
      await saveAll(db, [e], []);
    }
    await setMeta(db, 'schema', 3);
  }
}

async function start() {
  resetZoom();
  applySafeArea();
  addEventListener('resize', () => applySafeArea());
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
  await migrate(db, sched, byId, device);
  const states = await loadStates(db);

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

  const today = dayKey(new Date());
  const dayEvents = await eventsForDay(db, today);
  app = {
    db, sched, device, cards: file.cards, byId, states, today, dayEvents,
    rules: file.opening_rules ?? DEFAULT_RULES,
    openingIds: new Set(file.cards.filter((c) => c.deck === 'opening').map((c) => c.id)),
    set: deriveSet(today, dayEvents), cg, reloadWhenIdle: false,
  };
  // The menu is a tile in the counts row (nothing tappable sits in the top strip, which iOS blurs).
  $('#counts').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('#menu')) openMenu();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!app.sh || app.sh.done) && dayKey(new Date()) !== app.today) showNext();
  });
  if (BUILD_ID === 'dev') {
    // Local testing only (removed from published builds).
    (window as unknown as Record<string, unknown>).__test = { app: () => app, sync: () => sync, move: (u: string) => onMove(u.slice(0, 2) as Key, u.slice(2, 4) as Key), show: (id: string) => showCard(app.byId.get(id)!) };
  }
  showInstallHint();
  setupSync();
  await afterStart();
}

// ---------- sync (2.3)

function setupSync() {
  sync = new Sync({ ctx: () => app, device: () => app.device, onMerged, onStatus: showSyncStatus });
  afterCommit = () => sync.noteEvent();
  document.addEventListener('visibilitychange', () => void sync.run()); // on open and when leaving the app
  setInterval(() => { if (document.visibilityState === 'visible') void sync.run(); }, 120_000);
  $('#syncmsg').addEventListener('click', openSettings);
  registerSettingsSection(syncSettingsHtml, wireSyncSettings);
}

/** Events from the other device arrived: refresh today's set and the screen. */
async function onMerged(res: MergeResult) {
  if (res.days.has(app.today) || app.pendingSet) {
    app.pendingSet = undefined; // re-choose with the other device's reviews
    app.dayEvents = await eventsForDay(app.db, app.today);
    rederive();
  }
  renderCounts();
  const sh = app.sh;
  // Never pull a card away mid-answer; otherwise follow the merged set.
  if (!sh) {
    if (!$('#settings').hasAttribute('open')) await showNext();
  } else if (sh.attempts === 0 && !sh.done && !app.set.order.includes(sh.card.id)) {
    await showNext();
  }
}

function showSyncStatus(s: SyncStatus) {
  const el = $('#syncmsg');
  const loud = s.state === 'auth' || s.state === 'access' || s.state === 'public';
  el.hidden = !loud;
  if (loud) el.textContent = s.message;
  const live = document.getElementById('sync-status');
  if (live) live.textContent = syncLine(s);
}

function syncLine(s: SyncStatus): string {
  const last = s.lastOk ? `Last synced ${new Date(s.lastOk).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}.` : 'Never synced.';
  if (s.state === 'off') return `Not set up. ${s.waiting} review events waiting to upload.`;
  if (s.state === 'ok') return `${last} ${s.waiting} waiting to upload.`;
  if (s.state === 'syncing') return 'Syncing…';
  return `${s.message} ${last}`;
}

async function syncSettingsHtml(): Promise<string> {
  const cfg = await sync.config();
  const devApi = BUILD_ID === 'dev'
    ? `<label class="muted small">API address (testing only)<input type="text" id="sync-api" value="${esc(cfg?.api ?? DEFAULT_API)}"></label>` : '';
  return `
    <h3>Sync with your other devices</h3>
    <p id="sync-status" class="small">${esc(syncLine(sync.status))}</p>
    <label class="muted small">Private repository (owner/name)
      <input type="text" id="sync-repo" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(cfg?.repo ?? 'jakeb3ckman/chess-coach-progress')}"></label>
    <label class="muted small">Token ${cfg ? `(saved, ends …${esc(cfg.token.slice(-4))}; paste a new one to replace it)` : ''}
      <input type="text" id="sync-token" name="sync-key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
        data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" placeholder="github_pat_…"></label>
    ${devApi}
    <div class="buttons">
      <button id="sync-save" class="primary">${cfg ? 'Save and sync' : 'Turn on sync'}</button>
      ${cfg ? '<button id="sync-now" class="secondary">Sync now</button><button id="sync-remove" class="secondary">Remove token</button>' : ''}
    </div>`;
}

function wireSyncSettings(dlg: HTMLDialogElement) {
  const q = <T extends HTMLElement>(sel: string) => dlg.querySelector(sel) as T | null;
  q('#sync-save')?.addEventListener('click', async () => {
    const old = await sync.config();
    const repo = q<HTMLInputElement>('#sync-repo')!.value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    const token = q<HTMLInputElement>('#sync-token')!.value.trim() || old?.token || '';
    const api = q<HTMLInputElement>('#sync-api')?.value.trim() || undefined;
    const status = q('#sync-status')!;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { status.textContent = 'Enter the repository as owner/name, e.g. jakeb3ckman/chess-coach-progress.'; return; }
    if (!token) { status.textContent = 'Paste the token first.'; return; }
    await sync.saveConfig({ repo, token, ...(api && api !== DEFAULT_API ? { api } : {}) });
    status.textContent = 'Syncing…';
    const s = await sync.run();
    status.textContent = syncLine(s);
    if (s.state === 'ok') q<HTMLInputElement>('#sync-token')!.value = '';
  });
  q('#sync-now')?.addEventListener('click', async () => {
    q('#sync-status')!.textContent = 'Syncing…';
    q('#sync-status')!.textContent = syncLine(await sync.run());
  });
  q('#sync-remove')?.addEventListener('click', async () => {
    await sync.saveConfig(null);
    await sync.run();
    dlg.close();
    openSettings();
  });
}

/** Grade a card left waiting for Next, then show the right screen. */
async function afterStart() {
  const pending = await getMeta<{ day: string; card: string }>(app.db, 'pending_grade');
  if (pending && pending.day === app.today) await grade(pending.card, Rating.Good); // closed before Next
  else if (pending) await setMeta(app.db, 'pending_grade', null);
  // No set yet today and sync is on: give the other device's reviews a moment to
  // arrive first (at most 2.5 s), so both devices start from the same set.
  if (app.set.round === 0 && dayKey(new Date()) === app.today && await sync.config()) {
    await Promise.race([sync.run(), new Promise((r) => setTimeout(r, 2500))]);
  }
  const paused = await getMeta<string>(app.db, 'paused');
  if (paused === app.today && !isComplete(app.set) && app.set.round > 0) showPaused();
  else await showNext();
  void sync.run(); // after the first card is on screen
}

// ---------- the day's sets

function rederive() {
  app.set = deriveSet(app.today, app.dayEvents);
}

function setEvent(round: number, ids: string[]): ReviewEventV2 {
  return {
    id: crypto.randomUUID(), v: 2, card_id: '', ts: new Date().toISOString(), day: app.today, device: app.device,
    kind: 'set', showing: 0, sched: false, round, cards: ids,
  };
}

/** Log a new set of the day ('set' event) and make it current. */
async function startSet(round: number, ids: string[]) {
  const e = setEvent(round, ids);
  await saveAll(app.db, [e], []);
  app.dayEvents.push(e);
  rederive();
}

function cardsInTodaysSets(): Set<string> {
  const s = new Set<string>();
  for (const e of app.dayEvents) if (isSetEvent(e)) for (const id of e.cards ?? []) s.add(id);
  return s;
}

/** On a new study day, switch to it and make its first set. */
async function ensureToday() {
  const now = new Date();
  const today = dayKey(now);
  if (app.today !== today) {
    app.today = today;
    app.pendingSet = undefined;
    app.dayEvents = await eventsForDay(app.db, today);
    rederive();
  }
  if (app.set.round === 0) {
    const allowed = Math.max(0, NEW_PER_DAY - newStartedToday(app.states, today));
    const pick = chooseSetCards(app.cards, app.states, now, allowed, cardsInTodaysSets(), openingAllowed(today));
    const ids = [...pick.due, ...pick.fresh];
    if (ids.length) {
      app.pendingSet = setEvent(1, ids); // provisional until the first answer
      app.dayEvents.push(app.pendingSet);
      rederive();
    }
  }
}

/** New leak cards still allowed today (at most leak_cards_per_day, inside the 10 new). */
function openingAllowed(day: string): number {
  return Math.max(0, app.rules.leak_cards_per_day - newStartedTodayIn(app.states, day, app.openingIds));
}

function renderCounts() {
  const c = counts(app.set);
  const tile = (s: Status, label: string) => `<div class="cnt ${s}"><span class="lbl">${label}</span><b>${c[s]}</b></div>`;
  $('#counts').innerHTML = tile('remaining', 'Remaining') + tile('missed', 'Missed') + tile('unsure', 'Unsure') + tile('known', 'Known')
    + `<button class="cnt menu" id="menu" aria-label="Menu"><span class="lbl">Menu</span><b>☰</b></button>`;
}

// ---------- menu: Train / Openings / Insights / Settings

function openMenu() {
  const dlg = $('#menu-sheet') as HTMLDialogElement;
  dlg.innerHTML = `<div class="menu-list">
      <button data-go="train" class="secondary">Train</button>
      <button data-go="openings" class="secondary">Openings</button>
      <button data-go="insights" class="secondary">Insights</button>
      <button data-go="settings" class="secondary">Settings</button>
      <button data-go="close" class="link">Close</button></div>`;
  dlg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
    dlg.close();
    const go = b.dataset.go;
    if (go === 'train') showTrain();
    else if (go === 'openings' || go === 'insights') openPage(go, { db: app.db, byId: app.byId, onClose: showTrain });
    else if (go === 'settings') openSettings();
  }));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // tap outside closes
  dlg.showModal();
}

function showTrain() {
  closePage();
  app.cg.redrawAll(); // the board was hidden; chessground re-measures it
}

/** Full tiles while a card is asked; one thin row on the answer screen. */
function countsThin(on: boolean) {
  $('#counts').classList.toggle('thin', on);
}

async function showNext() {
  if (app.reloadWhenIdle) return location.reload();
  await ensureToday();
  renderCounts();
  const next = app.set.order.find((id) => app.byId.has(id)); // skip cards that left the deck
  if (!next || isComplete(app.set)) return showComplete();
  showCard(app.byId.get(next)!);
}

function idleBoard() {
  app.sh = undefined;
  countsThin(false);
  app.cg.set({ viewOnly: true, movable: { color: undefined, dests: new Map() }, drawable: { autoShapes: [] } });
}

async function firstTryRate(): Promise<{ rate: number; n: number }> {
  // Share of scheduling answers that were right, over the last 14 study days.
  let right = 0, n = 0;
  const now = Date.now();
  for (let d = 0; d < 14; d++) {
    const evs = await eventsForDay(app.db, dayKey(new Date(now - d * 86_400_000)));
    for (const e of evs) if (e.v === 2 && e.sched) { n++; if ((e.rating ?? 1) >= Rating.Good) right++; }
  }
  return { rate: n >= 5 ? right / n : 0.5, n };
}

async function showComplete() {
  markFirstScreen();
  idleBoard();
  renderCounts();
  const set = app.set;
  const pick = chooseSetCards(app.cards, app.states, new Date(), EXTRA_SET_NEW, cardsInTodaysSets(), openingAllowed(app.today));
  const more = pick.due.length + pick.fresh.length;
  let html: string;
  if (set.cards.length === 0) {
    banner('done', 'Nothing to review right now.');
    html = '';
  } else {
    const firstTry = set.cards.filter((id) => (set.showings[id] ?? 0) <= 1).length;
    banner('done', `✓ Set ${set.round > 1 ? set.round + ' ' : ''}complete`);
    html = `<p class="big">All ${set.cards.length} cards answered correctly.</p>
      <p>${firstTry} right on the first try, ${set.cards.length - firstTry} needed more than one showing.</p>`;
  }
  if (more) {
    const { rate, n } = await firstTryRate();
    const f = extraSetForecast(pick.fresh.length, rate);
    const parts = [];
    if (pick.fresh.length) parts.push(`${pick.fresh.length} new card${pick.fresh.length === 1 ? '' : 's'}`);
    if (pick.due.length) parts.push(`${pick.due.length} review${pick.due.length === 1 ? '' : 's'} due now`);
    html += `<div class="forecast"><p><b>Another set:</b> ${parts.join(' and ')}.</p>`;
    if (pick.fresh.length) {
      html += `<p class="muted">The new cards add about <b>${f.tomorrow}</b> review${f.tomorrow === 1 ? '' : 's'} tomorrow and <b>${f.dayAfter}</b> the day after
        (a miss comes back tomorrow, a right first answer in 2 days; based on ${n >= 5 ? `your first-try rate of ${Math.round(rate * 100)}% over the last 14 days` : 'an assumed 50% first-try rate until you have more reviews'}).</p>`;
    }
    html += `</div>`;
  } else if (set.cards.length) {
    html += `<p class="muted">No more cards right now. The next set is ready tomorrow after 4 a.m.</p>`;
  }
  $('#info').innerHTML = html;
  $('#actions').innerHTML = more ? `<div class="buttons"><button id="another" class="primary">Start another set</button></div>` : '';
  $('#another')?.addEventListener('click', async () => {
    $('#another').setAttribute('disabled', '');
    await startSet(set.round + 1, [...pick.due, ...pick.fresh]);
    await setMeta(app.db, 'paused', null);
    showNext();
  });
}

function showPaused() {
  idleBoard();
  renderCounts();
  banner('prompt', 'Set saved');
  $('#info').innerHTML = `<p>${app.set.order.length} card${app.set.order.length === 1 ? '' : 's'} left in this set. Your place is saved.</p>`;
  $('#actions').innerHTML = `<div class="buttons"><button id="resume" class="primary">Resume</button></div>`;
  $('#resume').addEventListener('click', async () => {
    await setMeta(app.db, 'paused', null);
    showNext();
  });
}

async function finishLater() {
  await setMeta(app.db, 'paused', app.today);
  showPaused();
}

// ---------- one showing

let firstScreenMarked = false;
function markFirstScreen() {
  if (firstScreenMarked) return;
  firstScreenMarked = true;
  performance.mark('first-screen'); // time from page start to the first card or set screen
}

function showCard(card: AppCard) {
  markFirstScreen();
  countsThin(false);
  const n = (app.set.showings[card.id] ?? 0) + 1;
  const st = app.states.get(card.id);
  app.sh = {
    card, n,
    first: !scheduledToday(st, app.today),
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
  $('#info').innerHTML = `
    <p class="muted">${where} · from your ${esc(card.occ[0].tc)} game, ${esc(card.occ[0].at)}${k > 1 ? ` · missed in ${k} games` : ''}</p>
    <p id="toolnote" class="muted"></p>`;
  $('#actions').innerHTML = `<p class="later"><button id="later" class="link">Finish later</button></p>`;
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
    id: crypto.randomUUID(), v: 2, card_id: sh.card.id, ts: new Date().toISOString(), day: app.today,
    device: app.device, kind, showing: sh.n, sched: false, ms: Math.round(performance.now() - sh.shownAt), ...extra,
  };
}

/** Save events and the card's new state in one transaction, then rebuild the set. */
async function commit(events: ReviewEventV2[], rating: number | null = null) {
  const sh = app.sh!;
  let st = app.states.get(sh.card.id);
  for (const e of events) st = applyEvent(app.sched, st, e, e.sched ? rating : null, !!e.habit);
  const pending = app.pendingSet;
  app.pendingSet = undefined; // the provisional set becomes real with the first answer
  await saveAll(app.db, pending ? [pending, ...events] : events, st ? [st] : []);
  if (st) app.states.set(sh.card.id, st);
  app.dayEvents.push(...events);
  rederive();
  renderCounts();
  afterCommit();
}

/** Hook for sync (2.3): called after every saved answer. */
let afterCommit: () => void = () => {};

/** First failure in a showing: the card becomes Missed; on the first showing of
 * the day this is the one event that tells the scheduler "Again". */
function failOnce(): { sched: boolean; status: Status } {
  const sh = app.sh!;
  if (sh.failed) return { sched: false, status: 'missed' };
  sh.failed = true;
  return { sched: sh.first, status: 'missed' };
}

async function onMove(orig: Key, dest: Key) {
  const sh = app.sh;
  if (!sh || sh.done) return;
  const card = sh.card;
  let uci = `${orig}${dest}`;
  if (isPromotion(card.fen, orig, dest)) uci += await pickPromotion(card.color);
  sh.attempts++;
  sh.attempt = uci;
  const verdict = judge(card, uci, app.rules);
  if (verdict.kind === 'right') {
    sh.done = true;
    if (!sh.failed) {
      const status = nextStatus(app.set.status[card.id] ?? 'remaining', true);
      if (sh.first) await setMeta(app.db, 'pending_grade', { day: app.today, card: card.id }); // Next / Too easy decides
      await commit([ev('move', { attempt: sh.attempts, move_played: uci, correct: true, status_after: status })]);
    } else {
      await commit([ev('move', { attempt: sh.attempts, move_played: uci, correct: true, status_after: 'missed' })]);
    }
    return showAnswer();
  }
  // Wrong: say so, put the piece back, let me try again.
  const habit = verdict.kind === 'habit';
  const f = failOnce();
  const e = ev('move', {
    attempt: sh.attempts, move_played: uci, correct: false, habit, status_after: f.status,
    sched: f.sched, rating: f.sched ? Rating.Again : undefined,
  });
  await commit([e], f.sched ? Rating.Again : null);
  const leakCard = card.deck === 'opening';
  banner('wrong', verdict.kind === 'habit'
    ? (leakCard ? "✗ That's the move you usually play here." : "✗ That's the move you played in the game.")
    : verdict.kind === 'playable' ? `✗ Playable, but there's better (−${verdict.behind.toFixed(1)} Win%). Try again.`
    : leakCard ? '✗ Not one of the good moves. Try again.' : '✗ Not the best move. Try again.');
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
  $('#actions').innerHTML = `<div class="buttons three">
      <button id="t-hint" class="secondary">Hint</button>
      <button id="t-sol" class="secondary">Solution</button>
      <button id="t-mine" class="secondary">My move</button></div>
    <p class="later"><button id="later" class="link">Finish later</button></p>`;
  $('#t-hint').addEventListener('click', onHint);
  $('#t-sol').addEventListener('click', onSolution);
  $('#t-mine').addEventListener('click', onMyMove);
  $('#later').addEventListener('click', finishLater);
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

async function showAnswer() {
  const sh = app.sh!;
  const card = sh.card;
  const best = sanOf(card.fen, card.solution);
  const g = card.game;
  const gameSan = sanOf(card.fen, g.move);
  const st = app.states.get(card.id);
  countsThin(true);
  const leakCard = card.deck === 'opening';
  const goodOther = leakCard && sh.attempt && sh.attempt !== card.solution && rightMoves(card).includes(sh.attempt) && !sh.revealed;
  const shown = goodOther ? sanOf(card.fen, sh.attempt!) : best;
  const word = leakCard ? 'Good move' : 'Solved';
  if (sh.revealed) banner('revealed', `Solution: <b>${esc(best)}</b>`);
  else if (!sh.failed) banner('done', `✓ ${word}: ${esc(shown)}`);
  else banner('done', `✓ ${word}: ${esc(shown)} <span class="sub">(counts as missed)</span>`);
  // Leak cards: the other right answers, from the position pass.
  const others = leakCard ? rightMoves(card).filter((u) => u !== card.solution).map((u) => sanOf(card.fen, u)) : [];
  const bestLabel = others.length ? `Best line · also good: ${others.map(esc).join(', ')}` : 'Best line';
  const played = leakCard
    ? `You usually play <b>${esc(gameSan)}</b> (${card.occ.filter((o) => o.move === g.move).length}×)`
    : `You played <b>${esc(gameSan)}</b>`;

  const tags = [...card.tags];
  if (st && st.habit > 0) tags.push(`habit ×${st.habit}`);
  const analysis = `https://lichess.org/analysis/standard/${card.fen.replace(/ /g, '_')}?color=${card.color}`;
  const drop = (g.win_before - g.win_after).toFixed(1);
  // One block for the game move and its refutation: they share one evaluation.
  const refChips = sh.lines.ref.length
    ? `<div class="moves">${lineChips('ref')}</div>`
    : `<p class="muted small">Refutation line not computed yet.</p>`;
  $('#info').innerHTML = `
    <div id="essential">
      <div class="row"><span class="what">${bestLabel}</span><span class="ev">${esc(evalWords(card.best_eval))}</span></div>
      <div class="moves">${lineChips('best')}</div>
      <div class="row"><span class="what">${played}${sh.lines.ref.length ? ', refuted by' : ''}</span><span class="ev">${esc(evalWords(g.eval))}</span></div>
      ${refChips}
    </div>
    <p class="muted small">Pawns from your side. Win% ${g.win_before.toFixed(1)} → ${g.win_after.toFixed(1)} (−${drop})${leakCard ? ` · played in ${card.occ.length} games` : card.occ.length > 1 ? ` · missed in ${card.occ.length} games` : ''}</p>
    ${tags.length ? `<p class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
    <div class="stepper"><button class="step" id="start" aria-label="Back to the puzzle">↺</button><button class="step" id="prev" aria-label="Back">◀</button><button class="step" id="next" aria-label="Forward">▶</button></div>
    <p class="links"><a href="${esc(card.occ[0].link)}" target="_blank" rel="noopener">Open the game ↗</a><a href="${esc(analysis)}" target="_blank" rel="noopener">Analysis board ↗</a></p>`;
  $('#info').scrollTop = 0;
  $('#info').querySelectorAll<HTMLButtonElement>('.mv').forEach((b) =>
    b.addEventListener('click', () => view(b.dataset.line as 'best' | 'ref', Number(b.dataset.i))));
  $('#start').addEventListener('click', () => view('best', -1));
  $('#prev').addEventListener('click', () => view(sh.view.line, sh.view.idx - 1));
  $('#next').addEventListener('click', () => view(sh.view.line, sh.view.idx + 1));
  await renderGradeButtons();
  view('best', sh.revealed || sh.failed ? -1 : 0);
  requestAnimationFrame(measureAnswer);
}

/** Where the answer screen's lines end and the Next button starts, for the
 * Settings diagnostics (the board no longer shrinks to make room). */
let answerFit = '';
function measureAnswer() {
  const ess = document.getElementById('essential');
  const act = document.getElementById('actions');
  if (!ess || !act) return;
  // No half line peeking out above the buttons: the first item below the
  // must-see lines that doesn't fully fit starts just below the visible area.
  const info = $('#info');
  const fold = info.getBoundingClientRect().bottom;
  for (const el of Array.from(info.children) as HTMLElement[]) {
    if (el === ess) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > fold + 0.5) {
      if (r.top < fold) el.style.marginTop = `${Math.ceil(fold - r.top + 12)}px`;
      break;
    }
  }
  const end = Math.round(ess.getBoundingClientRect().bottom);
  const next = Math.round(act.getBoundingClientRect().top);
  answerFit = `lines end at y=${end}, Next area starts at y=${next} (${end <= next ? 'fits' : `${end - next}px hidden, scroll to see`})`;
}

async function renderGradeButtons() {
  const sh = app.sh!;
  const card = sh.card;
  const now = new Date();
  const box = $('#actions');
  const pending = await getMeta<{ day: string; card: string }>(app.db, 'pending_grade');
  if (pending?.card === card.id && pending.day === app.today) {
    const st = app.states.get(card.id);
    const good = returnText(previewDue(app.sched, st, Rating.Good, now, card.id), now);
    const easy = returnText(previewDue(app.sched, st, Rating.Easy, now, card.id), now);
    box.innerHTML = `<div class="buttons">
      <button id="easy" class="secondary">Too easy<small>Back ${esc(easy)}</small></button>
      <button id="go" class="primary">Next<small>Back ${esc(good)}</small></button></div>`;
    $('#easy').addEventListener('click', () => grade(card.id, Rating.Easy).then(showNext));
    $('#go').addEventListener('click', async () => {
      $('#go').setAttribute('disabled', '');
      await grade(card.id, Rating.Good);
      showNext();
    });
    return;
  }
  const status = app.set.status[card.id];
  const st = app.states.get(card.id);
  const due = st ? returnText(st.fsrs.dueAt, now) : '';
  const cap = status === 'missed' ? `Again in a few cards, then back ${due}`
    : status === 'unsure' ? 'Once more later in this set'
    : `Known for today · back ${due}`;
  box.innerHTML = `<div class="buttons"><button id="go" class="primary">Next<small>${esc(cap)}</small></button></div>`;
  $('#go').addEventListener('click', () => { $('#go').setAttribute('disabled', ''); showNext(); });
}

/** The scheduling event for a card answered right on its first showing today. */
async function grade(cardId: string, rating: number) {
  await setMeta(app.db, 'pending_grade', null);
  const card = app.byId.get(cardId);
  if (!card) return;
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
  $('#info').querySelectorAll<HTMLElement>('.mv').forEach((b) =>
    b.classList.toggle('on', b.dataset.line === line && Number(b.dataset.i) === idx));
  const on = $('#info').querySelector<HTMLElement>('.mv.on');
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

// ---------- settings, backup, install hint

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

/** Extra Settings sections (sync adds one in 2.3). */
const settingsSections: (() => Promise<string>)[] = [];
const settingsWiring: ((dlg: HTMLDialogElement) => void)[] = [];

async function openSettings() {
  const dlg = $('#settings') as HTMLDialogElement;
  const [waiting, persisted] = await Promise.all([outboxCount(app.db), navigator.storage?.persisted?.() ?? Promise.resolve(false)]);
  const started = [...app.states.keys()].filter((k) => app.byId.has(k)).length;
  const sa = safeArea;
  const extra = (await Promise.all(settingsSections.map((f) => f()))).join('');
  dlg.innerHTML = `
    <h2>Settings</h2>
    <dl>
      <dt>Version</dt><dd><b>${esc(APP_VERSION)}</b> (build ${esc(BUILD_ID)})</dd>
      <dt>Review events not yet uploaded</dt><dd>${waiting}</dd>
      <dt>Deck</dt><dd>${app.cards.length} cards, ${started} started</dd>
      <dt>Today</dt><dd>set ${app.set.round || '-'}: ${app.set.cards.length} cards (${app.today})</dd>
      <dt>Home Screen app</dt><dd>${isStandalone() ? 'yes' : 'no, running in the browser'}</dd>
      <dt>Storage</dt><dd>${persisted ? 'persistent' : 'not marked persistent (iOS may clear it if the device runs low on space)'}</dd>
      <dt>Device name</dt><dd>${esc(app.device)}</dd>
    </dl>
    ${extra}
    <h3>Space at the top</h3>
    <p class="muted small">Keeps the top bar out of the blurred strip under the status bar.
      Measured: page ${document.documentElement.clientWidth}×${document.documentElement.clientHeight}, screen ${screen.width}×${screen.height},
      zoom ${zoomText()}, reported safe area top ${sa.envTop}px / bottom ${sa.envBottom}px${sa.full ? ', page runs under the status bar' : ''}.
      Using ${sa.top}px top, ${sa.bottom}px bottom.<br>
      Board: ${rectText('#board')}. Counts row: ${rectText('#counts')}.
      Answer screen: ${answerFit || 'not shown yet since the app opened'}.</p>
    <div class="seg" id="topspace">
      ${['auto', 'on', 'off'].map((m) => `<button data-m="${m}" class="${sa.mode === m ? 'on' : ''}">${m === 'auto' ? 'Automatic' : m === 'on' ? 'Always' : 'Never'}</button>`).join('')}
    </div>
    <h3>Backup</h3>
    <div class="buttons">
      <button id="backup" class="secondary">Save a backup</button>
      <button id="restore" class="secondary">Restore from backup</button>
    </div>
    <input type="file" id="restore-file" accept="application/json,.json" hidden>
    <p id="restore-msg" class="muted small"></p>
    <div class="buttons"><button id="close" class="primary">Close</button></div>`;
  $('#close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', resetZoom, { once: true });
  $('#backup').addEventListener('click', saveBackup);
  $('#restore').addEventListener('click', () => $<HTMLInputElement>('#restore-file').click());
  $<HTMLInputElement>('#restore-file').addEventListener('change', (e) => restoreBackup((e.target as HTMLInputElement).files?.[0]));
  dlg.querySelectorAll<HTMLButtonElement>('#topspace button').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem('topSpace', b.dataset.m!); } catch { /* ignore */ }
    applySafeArea();
    dlg.close();
    openSettings();
  }));
  for (const w of settingsWiring) w(dlg);
  if (!dlg.open) dlg.showModal();
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

/** Bring events from a saved backup back: events already here are skipped, the
 * rest are added (and queued for upload), and the affected schedules rebuilt. */
async function restoreBackup(file: File | undefined) {
  const msg = $('#restore-msg');
  if (!file) return;
  let events: ReviewEvent[];
  try {
    const data = JSON.parse(await file.text());
    events = cleanEvents(Array.isArray(data) ? data : data?.events);
  } catch {
    msg.textContent = 'That file is not a Chess Coach backup (not valid JSON).';
    return;
  }
  if (!events.length) {
    msg.textContent = 'No reviews found in that file.';
    return;
  }
  const res = await mergeEvents(app, events, 0);
  if (res.days.has(app.today) || app.pendingSet) {
    app.pendingSet = undefined;
    app.dayEvents = await eventsForDay(app.db, app.today);
    rederive();
  }
  msg.textContent = res.added
    ? `Restored ${res.added} review event${res.added === 1 ? '' : 's'} (${res.already} were already here). ${res.cards.size} card schedule${res.cards.size === 1 ? '' : 's'} rebuilt.`
    : `Nothing new: all ${res.already} events in that backup are already on this device.`;
  if (res.added && (!app.sh || app.sh.done || app.sh.attempts === 0)) showNext();
  if (res.added) void sync.run();
}

function registerSettingsSection(render: () => Promise<string>, wire: (dlg: HTMLDialogElement) => void) {
  settingsSections.push(render);
  settingsWiring.push(wire);
}

start().catch((e) => {
  $('#info').innerHTML = `<p class="bad">Could not start: ${esc(String(e?.message ?? e))}</p>`;
});
