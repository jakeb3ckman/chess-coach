// Openings and Insights screens (Phase 3, docs/phase-3-plan.md). Both read files
// the nightly run builds from stored games and Stockfish output (openings.json,
// insights.json). Training lines are computed here from this device's review
// log, which never leaves the device except to the private progress repository.
import { Chessground } from '@lichess-org/chessground';
import { allEvents } from './db.ts';
import { dayKey } from './day.ts';
import { sanOf } from './chessutil.ts';
import type { AppCard } from './types.ts';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Color = 'white' | 'black';
type TC = 'all' | 'bullet' | 'blitz' | 'rapid';
interface Rec { n: number; w: number; d: number; l: number; score: number | null }
interface Trend { from: string; to: string; games: number; score: number; expected: number; diff: number; lo: number; hi: number }
interface Period { n: number; good: number; old: number; other: number; unchecked: number }
interface Blund { blunders: number; moves: number; games: number }
interface ProgLeak { node: string; path: string; kinds: string[]; old: string[]; good: string[]; good_complete: boolean; before: Period; since: Period }
interface Group extends Rec {
  name: string; family: string; tc: Record<'bullet' | 'blitz' | 'rapid', Rec>; node: string | null; eco: string | null; trend?: Trend[];
  progress?: { blunders: { before: Blund; since: Blund }; leaks: ProgLeak[] };
}
interface NodeMove extends Rec { u: string; s: string; to: string | null; behind?: number }
interface TreeNode {
  fen: string; color: Color; me: boolean; games: number; path: string; name: string | null; moves: NodeMove[];
  engine?: { u: string; s: string; behind: number; eval: string }[];
  compare?: { usual: string; alt: string | null; engine: string | null };
}
interface Reply extends Rec { color: Color; after: string; node: string; reply: string; of: number; to: string | null }
interface Leak {
  node: string; color: Color; path: string; name: string | null; fen: string; kind: 'error' | 'repertoire';
  move: string; move_san: string; best: string; best_san: string; drop: number; played: number; reached: number;
  total: number; mine: Rec; best_rec: Rec; links: string[]; card: string | null;
}
interface OpeningsFile {
  format: number; games: number; groups: Record<Color, Group[]>; replies: Reply[]; leaks: Leak[];
  nodes: Record<string, TreeNode>; start: Record<Color, string>;
  progress?: { start: string; min_games_since: number; right_within: number; ratings?: { rows: RatingRow[]; min_games: number } };
  rules: { leak_min_drop: number; leak_error_drop: number; right_within: number; group_min_games: number; trend_block: number };
}
interface InsightTable { title: string; head: string[]; rows: string[][] }
interface InsightLine { id: string; title: string; stat: string; sample: string; detail?: string; status: 'shown' | 'checked'; tip: string | null; tables?: InsightTable[] }
interface RatingRow {
  site: 'chesscom' | 'lichess'; tc: 'bullet' | 'blitz' | 'rapid'; start: number | null; now: number; now_date: string;
  games: number; w: number; d: number; l: number; enough: boolean; opp_avg?: number; perf?: number; lo?: number; hi?: number;
}
interface InsightsFile { format: number; games: number; lines: InsightLine[]; thresholds: { games: number; moves: number; events: number; comparisons: string } }

export interface PageCtx { db: IDBDatabase; byId: Map<string, AppCard>; onClose: () => void }

let ctx: PageCtx;
let back: (() => void)[] = [];
let openings: OpeningsFile | null = null;
type CardStatus = 'known' | 'unsure' | 'missed';
let cardStatus = new Map<string, CardStatus>(); // from this device's reviews; never leaves the device
const ui = { color: 'white' as Color, tc: 'all' as TC };

async function load<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export function openPage(which: 'openings' | 'insights', c: PageCtx) {
  ctx = c;
  back = [];
  $('#app').classList.add('paged');
  $('#page').hidden = false;
  $('#page-close').onclick = () => ctx.onClose();
  $('#page-back').onclick = () => { const f = back.pop(); if (f) f(); setBack(); };
  setBack();
  if (which === 'openings') showOpenings();
  else showInsights();
}

export function closePage() {
  $('#app').classList.remove('paged');
  $('#page').hidden = true;
  $('#page-body').innerHTML = '';
}

function setBack() { $('#page-back').hidden = back.length === 0; }

function frame(title: string, html: string) {
  $('#page-title').textContent = title;
  const body = $('#page-body');
  body.innerHTML = html;
  body.scrollTop = 0;
}

function go(next: () => void, current: () => void) {
  back.push(current);
  setBack();
  next();
}

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x)}%`);
const wdl = (r: Rec) => `${r.w}–${r.d}–${r.l}`;
const recText = (r: Rec) => (r.n ? `${r.n} game${r.n === 1 ? '' : 's'} · ${wdl(r)} · ${pct(r.score)}` : 'not played');

function seg(id: string, opts: [string, string][], on: string, small = false) {
  return `<div class="seg${small ? ' small' : ''}" id="${id}">${opts.map(([v, l]) => `<button data-v="${v}" class="${v === on ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

// ---------------------------------------------------------------- Openings

async function showOpenings() {
  frame('Openings', '<p class="muted">Loading…</p>');
  try {
    openings ??= await load<OpeningsFile>('data/openings.json');
  } catch {
    frame('Openings', '<p>The openings file isn’t available offline yet. Open this screen once while online.</p>');
    return;
  }
  cardStatus = await statusesFromLog();
  renderOpenings();
}

/** Each card's status after its latest showing, from this device's review log. */
async function statusesFromLog(): Promise<Map<string, CardStatus>> {
  const out = new Map<string, CardStatus>();
  const latest = new Map<string, string>();
  for (const e of await allEvents(ctx.db)) {
    const st: CardStatus | undefined = e.v === 2
      ? (e.status_after === 'remaining' ? undefined : e.status_after)
      : (e.correct ? 'known' : 'missed');
    if (!st || !e.card_id) continue;
    if ((latest.get(e.card_id) ?? '') <= e.ts) { latest.set(e.card_id, e.ts); out.set(e.card_id, st); }
  }
  return out;
}

const per100 = (b: Blund) => (b.moves ? (100 * b.blunders / b.moves).toFixed(1) : '–');
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

function progressHtml(c: Color): string {
  const o = openings!;
  const pr = o.progress;
  if (!pr) return '';
  const min = pr.min_games_since;
  const counts = new Map<string, Record<CardStatus | 'unseen', number>>();
  for (const card of ctx.byId.values()) {
    if (card.color !== c || !card.opening) continue;
    const k = counts.get(card.opening) ?? { known: 0, unsure: 0, missed: 0, unseen: 0 };
    k[cardStatus.get(card.id) ?? 'unseen']++;
    counts.set(card.opening, k);
  }
  const groups = o.groups[c].filter((g) => g.progress && g.n >= o.rules.group_min_games);
  const sinceGames = (g: Group) => g.progress!.blunders.since.games;
  groups.sort((a, b) => sinceGames(b) - sinceGames(a) || b.n - a.n);
  const period = (p: Period, label: string, enough: boolean) => p.n
    ? `${label}: good move ${p.good}, old move ${p.old}, other ${p.other}${p.unchecked ? `, not checked ${p.unchecked}` : ''} of ${plural(p.n, 'game')}`
      + (enough ? ` (${Math.round(100 * p.good / p.n)}% good)` : '')
    : `${label}: not reached`;
  const groupCard = (g: Group) => {
    const pg = g.progress!;
    const b = pg.blunders;
    const enoughB = b.since.games >= min;
    const k = counts.get(g.name) ?? { known: 0, unsure: 0, missed: 0, unseen: 0 };
    const nCards = k.known + k.unsure + k.missed + k.unseen;
    const leaks = pg.leaks;
    const leakRow = (l: ProgLeak) => {
      const enough = l.since.n >= min;
      return `<div class="pl">
        <div><b>${esc(l.path || 'Start')}</b> <span class="badge ${l.kinds.includes('error') ? 'err' : 'rep'}">${l.kinds.includes('error') ? 'error' : 'repertoire choice'}</span></div>
        <div class="sub">Good: ${l.good.map(esc).join(', ')}${l.good_complete ? '' : ' (and possibly others not checked)'} · old: ${l.old.map(esc).join(', ')}</div>
        <div class="sub">${period(l.before, 'Before', l.before.n >= min)}</div>
        <div class="sub">${period(l.since, 'Since', enough)}${l.since.n && !enough ? ' · not enough games yet' : ''}</div>
      </div>`;
    };
    const reached = leaks.filter((l) => l.since.n > 0);
    const rest = leaks.filter((l) => l.since.n === 0);
    return `<div class="item prog">
      <div class="top"><span class="name">${esc(g.name)}</span><span class="num">${plural(b.since.games, 'game')} since</span></div>
      <div class="sub"><b>Blunders per 100 moves</b> in your first 15 moves: before ${per100(b.before)} (${b.before.blunders} in ${plural(b.before.moves, 'move')}, ${plural(b.before.games, 'game')}) ·
        since ${per100(b.since)} (${b.since.blunders} in ${plural(b.since.moves, 'move')}, ${plural(b.since.games, 'game')})${enoughB ? '' : ' · not enough games yet'}</div>
      <div class="sub"><b>Cards</b>${nCards ? `: Known ${k.known} · Unsure ${k.unsure} · Missed ${k.missed} · not yet seen ${k.unseen}` : ': none from this opening'}</div>
      ${reached.map(leakRow).join('')}
      ${rest.length ? `<details><summary class="sub">${plural(rest.length, 'leak position')} not reached since ${pr.start}</summary>${rest.map(leakRow).join('')}</details>` : ''}
    </div>`;
  };
  const active = groups.filter((g) => sinceGames(g) > 0);
  const idle = groups.filter((g) => sinceGames(g) === 0);
  return `
    <h3>Progress since ${pr.start}</h3>
    ${ratingsHtml()}
    <p class="muted small">Your training start date (a setting). Games ending on or after it count as "since".
      A good move is within ${pr.right_within} Win% of Stockfish's best (position pass); "old move" is your leak move there.
      Comparisons resting on fewer than ${min} games since the start say "not enough games yet"; the counts are always shown.
      All time controls. Card statuses are your latest result on each card, counted on this device from your reviews and never published.</p>
    <div class="list">${active.map(groupCard).join('') || '<p class="muted">No games in your groups since the start date yet.</p>'}</div>
    ${idle.length ? `<details class="checked"><summary>${plural(idle.length, 'opening')} with no games since ${pr.start}</summary><div class="list">${idle.map(groupCard).join('')}</div></details>` : ''}`;
}

const SITE = { chesscom: 'Chess.com', lichess: 'Lichess' } as const;

/** One line per site and format: rating at the start and now, performance since. */
function ratingsHtml(): string {
  const rt = openings!.progress?.ratings;
  if (!rt?.rows.length) return '';
  const row = (r: RatingRow) => {
    const perf = r.games === 0 ? 'no games since the start'
      : r.enough && r.perf !== undefined
        ? `performance <b>${r.perf}</b> (95%: ${r.lo} to ${r.hi}) from ${plural(r.games, 'game')}, ${r.w}–${r.d}–${r.l}, average opponent ${r.opp_avg}`
        : `${plural(r.games, 'game')} since, ${r.w}–${r.d}–${r.l} · not enough games yet (${rt.min_games} needed)`;
    return `<div class="item"><div class="top"><span class="name">${SITE[r.site]} ${r.tc}</span>
      <span class="num">${r.start ?? '–'} → ${r.now}</span></div><div class="sub">${perf}</div></div>`;
  };
  return `<div class="ratings"><p class="muted small">Rated games only. Left: your rating at the start date; right: your rating now, from your latest game (Lichess files store the rating before each game, so the last game's change isn't included).
    Performance rating: the rating at which the Elo formula expects your actual score against your actual opponents since the start; 95% interval from resampling whole games. Each site's own rating scale.</p>
    <div class="list">${rt.rows.map(row).join('')}</div></div>`;
}

function renderOpenings() {
  const o = openings!;
  const c = ui.color;
  const rows = o.groups[c].map((g) => ({ g, r: ui.tc === 'all' ? (g as Rec) : g.tc[ui.tc] })).filter((x) => x.r.n > 0);
  const replies = o.replies.filter((r) => r.color === c).slice(0, 10);
  const errors = o.leaks.filter((l) => l.color === c && l.kind === 'error');
  const reps = o.leaks.filter((l) => l.color === c && l.kind === 'repertoire');
  const leakItem = (l: Leak) => `
    <button class="item" data-node="${l.node}">
      <div class="top"><span class="name">${esc(l.path || 'Start')}…</span><span class="num">−${l.drop.toFixed(1)} Win%</span></div>
      <div class="sub">${esc(l.name ?? '')} · reached in ${l.reached} games${l.card ? ' · <b>in your review deck</b>' : ''}</div>
      <div class="pair">
        <div>Your move <b>${esc(l.move_san)}</b><br>${recText(l.mine)}</div>
        <div>Engine’s move <b>${esc(l.best_san)}</b><br>${recText(l.best_rec)}</div>
      </div>
    </button>`;
  frame('Openings', `
    ${seg('o-color', [['white', 'As White'], ['black', 'As Black']], c)}
    ${seg('o-tc', [['all', 'All'], ['bullet', 'Bullet'], ['blitz', 'Blitz'], ['rapid', 'Rapid']], ui.tc, true)}
    ${progressHtml(c)}
    <h3>Repertoire</h3>
    <p class="muted small">Grouped by variation (${o.rules.group_min_games}+ games), smaller lines pooled under their family. Score = (wins + ½ draws) / games.</p>
    <div class="list">${rows.map(({ g, r }, i) => `
      <button class="item" data-group="${i}">
        <div class="top"><span class="name">${esc(g.name)}</span><span class="num">${pct(r.score)}</span></div>
        <div class="sub">${r.n} games · ${wdl(r)}${g.trend ? ' · trend' : ''}</div>
      </button>`).join('')}</div>
    <h3>What opponents play against you</h3>
    <div class="list">${replies.map((r) => `
      <button class="item" data-node="${r.to ?? r.node}">
        <div class="top"><span class="name">${esc(r.after)} <b>${esc(r.reply)}</b></span><span class="num">${pct(r.score)}</span></div>
        <div class="sub">${r.n} of ${r.of} games (${Math.round((100 * r.n) / r.of)}%) · your W–D–L ${wdl(r)}</div>
      </button>`).join('')}</div>
    <h3>Opening errors <span class="badge err">${o.rules.leak_error_drop}+ Win%</span></h3>
    <p class="muted small">Positions you reached at least 3 times where a move you played twice or more loses ${o.rules.leak_error_drop} Win% or more, by Stockfish's position search. These become review cards.</p>
    <div class="list">${errors.map(leakItem).join('') || '<p class="muted">None.</p>'}</div>
    <h3>Repertoire choices <span class="badge rep">${o.rules.leak_min_drop}–${o.rules.leak_error_drop} Win%</span></h3>
    <p class="muted small">Same rule, losing ${o.rules.leak_min_drop} to ${o.rules.leak_error_drop} Win%: moves Stockfish rates a little worse. No cards; your results with each move side by side.</p>
    <div class="list">${reps.map(leakItem).join('') || '<p class="muted">None.</p>'}</div>`);
  const body = $('#page-body');
  body.querySelectorAll<HTMLButtonElement>('#o-color button').forEach((b) => b.addEventListener('click', () => { ui.color = b.dataset.v as Color; renderOpenings(); }));
  body.querySelectorAll<HTMLButtonElement>('#o-tc button').forEach((b) => b.addEventListener('click', () => { ui.tc = b.dataset.v as TC; renderOpenings(); }));
  body.querySelectorAll<HTMLButtonElement>('[data-group]').forEach((b) => b.addEventListener('click', () =>
    go(() => showGroup(rows[Number(b.dataset.group)].g), renderOpenings)));
  body.querySelectorAll<HTMLButtonElement>('[data-node]').forEach((b) => b.addEventListener('click', () =>
    go(() => showNode(b.dataset.node!), renderOpenings)));
}

function trendSvg(t: Trend[]): string {
  const W = 320, H = 130, top = 10, bottom = 100, left = 30, right = 10;
  const m = Math.max(10, ...t.map((b) => Math.max(Math.abs(b.lo), Math.abs(b.hi))));
  const y = (v: number) => top + ((m - v) / (2 * m)) * (bottom - top);
  const step = (W - left - right) / t.length;
  const x = (i: number) => left + step * (i + 0.5);
  const fmt = (d: string) => d.slice(5).replace('-', '/');
  return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating-adjusted score per block of games">
    <line x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}" stroke="#777" stroke-dasharray="3 3"/>
    <text x="${left - 4}" y="${y(m) + 4}" fill="#a9a59f" font-size="10" text-anchor="end">+${Math.round(m)}</text>
    <text x="${left - 4}" y="${y(0) + 4}" fill="#a9a59f" font-size="10" text-anchor="end">0</text>
    <text x="${left - 4}" y="${y(-m) + 4}" fill="#a9a59f" font-size="10" text-anchor="end">−${Math.round(m)}</text>
    ${t.map((b, i) => `
      <line x1="${x(i)}" x2="${x(i)}" y1="${y(b.hi)}" y2="${y(b.lo)}" stroke="#8fb3e0" stroke-width="2"/>
      <circle cx="${x(i)}" cy="${y(b.diff)}" r="4" fill="${b.diff >= 0 ? '#7fbf4d' : '#ef6b61'}"/>
      <text x="${x(i)}" y="${bottom + 14}" fill="#a9a59f" font-size="9" text-anchor="middle">${fmt(b.to)}</text>`).join('')}
  </svg>`;
}

function showGroup(g: Group) {
  const o = openings!;
  const tcs = (['bullet', 'blitz', 'rapid'] as const).filter((t) => g.tc[t].n);
  frame(g.name, `
    <div class="item"><div class="top"><span class="name">All games</span><span class="num">${pct(g.score)}</span></div>
      <div class="sub">${g.n} games · ${wdl(g)}${g.eco ? ` · ECO ${esc(g.eco)}` : ''}</div></div>
    <div class="pair">${tcs.map((t) => `<div>${t[0].toUpperCase() + t.slice(1)}<br><b>${pct(g.tc[t].score)}</b> · ${g.tc[t].n} games · ${wdl(g.tc[t])}</div>`).join('')}</div>
    ${g.trend ? `
      <h3>Score against your rating over time</h3>
      <p class="muted small">Your score minus the score expected from the two ratings (Elo formula), in points, per block of ${o.rules.trend_block} games, oldest first. Dots above 0: better than your rating predicts. Bars: 95% interval; a block's result is only clear when its bar doesn't cross 0.</p>
      ${trendSvg(g.trend)}
      <div class="list">${g.trend.map((b) => `<div class="item"><div class="top"><span class="name">${b.from} → ${b.to}</span><span class="num">${b.diff >= 0 ? '+' : '−'}${Math.abs(b.diff).toFixed(1)}</span></div>
        <div class="sub">${b.games} games · scored ${b.score}% vs ${b.expected}% expected · interval ${b.lo >= 0 ? '+' : '−'}${Math.abs(b.lo).toFixed(1)} to ${b.hi >= 0 ? '+' : '−'}${Math.abs(b.hi).toFixed(1)}</div></div>`).join('')}</div>`
      : `<p class="muted small">The score over time appears from 60 games (this group has ${g.n}).</p>`}
    <div class="buttons"><button id="g-explore" class="primary">Explore the moves</button></div>`);
  $('#g-explore').addEventListener('click', () => {
    const key = g.node && o.nodes[g.node] ? g.node : o.start[ui.color];
    go(() => showNode(key), () => showGroup(g));
  });
}

function showNode(key: string) {
  const o = openings!;
  const n = o.nodes[key];
  if (!n) { frame('Openings', '<p>That position isn’t in the tree.</p>'); return; }
  const turn = n.fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  const mv = (u: string) => n.moves.find((m) => m.u === u);
  const boxes = n.compare ? [
    ['Your usual move', mv(n.compare.usual)],
    ['Better-scoring, also played', n.compare.alt ? mv(n.compare.alt) : undefined],
    ['Engine’s move, also played', n.compare.engine ? mv(n.compare.engine) : undefined],
  ].filter((x): x is [string, NodeMove] => !!x[1]) : [];
  const behind = (m: NodeMove) => (m.behind === undefined ? '' : m.behind < 0.05 ? ' · engine’s best' : ` · −${m.behind.toFixed(1)} Win%`);
  frame(n.name ?? 'Openings', `
    <div class="mini-board" id="mini"></div>
    <p class="small"><b>${esc(n.path || 'Start position')}</b></p>
    <p class="muted small">${turn} to move (${n.me ? 'you' : 'your opponent'}) · reached in ${n.games} of your games as ${n.color}</p>
    ${boxes.length > 1 ? `
      <h3>Your results side by side</h3>
      <div class="pair">${boxes.map(([label, m]) => `<div>${label} <b>${esc(m.s)}</b><br>${recText(m)}${behind(m)}</div>`).join('')}</div>` : ''}
    ${n.engine ? `
      <h3>Stockfish’s top moves</h3>
      <p class="small">${n.engine.map((e, i) => `${esc(e.s)} ${i === 0 ? `(best, ${esc(e.eval)})` : `(−${e.behind.toFixed(1)} Win%)`}`).join(' · ')}</p>
      <p class="muted small">Position search, 5M nodes, 5 lines. Win% behind the best move.</p>` : ''}
    <h3>Moves played here</h3>
    <div class="list tree-moves">${n.moves.map((m) => `
      <button class="item" ${m.to ? `data-to="${m.to}"` : 'disabled'}>
        <span class="mv-san">${esc(m.s)}</span>
        <span class="sub">${m.n} game${m.n === 1 ? '' : 's'} · ${wdl(m)}${behind(m)}</span>
        <span class="num">${pct(m.score)}${m.to ? ' ›' : ''}</span>
      </button>`).join('')}</div>
    <p class="muted small">Your results after each move. Moves leading to positions reached fewer than 3 times can’t be opened.</p>`);
  Chessground($('#mini'), {
    fen: n.fen, orientation: n.color, viewOnly: true, coordinates: false,
    animation: { enabled: false }, drawable: { enabled: false, visible: true },
  });
  $('#page-body').querySelectorAll<HTMLButtonElement>('[data-to]').forEach((b) => b.addEventListener('click', () =>
    go(() => showNode(b.dataset.to!), () => showNode(key))));
}

// ---------------------------------------------------------------- Insights

function tableHtml(t: InsightTable): string {
  return `<p class="tt">${esc(t.title)}</p><table><thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

async function showInsights() {
  frame('Insights', '<p class="muted">Loading…</p>');
  let f: InsightsFile;
  try {
    f = await load<InsightsFile>('data/insights.json');
  } catch {
    frame('Insights', '<p>The insights file isn’t available offline yet. Open this screen once while online.</p>');
    return;
  }
  const fact = (l: InsightLine) => `
    <div class="fact">
      <h4>${esc(l.title)}</h4>
      <p class="stat">${esc(l.stat)}</p>
      ${(l.tables ?? []).map(tableHtml).join('')}
      <p class="samp">Based on ${esc(l.sample)}.</p>
      ${l.detail ? `<p class="det">${esc(l.detail)}</p>` : ''}
      ${l.tip && l.status === 'shown' ? `<div class="tip"><span class="tl">Tip · general advice, not computed from your games</span>${esc(l.tip)}</div>` : ''}
    </div>`;
  const shown = f.lines.filter((l) => l.status === 'shown');
  const checked = f.lines.filter((l) => l.status === 'checked');
  const t = f.thresholds;
  frame('Insights', `
    <p class="muted small">Every number is counted from your ${f.games.toLocaleString()} games and Stockfish's stored analysis, rebuilt each night.
      A line appears only with at least ${t.games} games, ${t.moves} moves or ${t.events} events behind it; a comparison only when ${esc(t.comparisons)}.
      Tips are fixed general advice, kept separate from the numbers.</p>
    ${shown.map(fact).join('')}
    <h3>Training</h3>
    <div id="training"><p class="muted">Counting your reviews…</p></div>
    ${checked.length ? `<details class="checked"><summary>Checked, no clear pattern (${checked.length})</summary>${checked.map(fact).join('')}</details>` : ''}`);
  $('#training').innerHTML = await trainingHtml();
}

/** First-try rate per week and most repeated habits, from this device's log. */
async function trainingHtml(): Promise<string> {
  const evs = await allEvents(ctx.db);
  const firsts: { day: string; right: boolean }[] = [];
  const seenV1 = new Set<string>();
  for (const e of [...evs].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (e.v === 2 && e.sched && e.rating !== undefined) firsts.push({ day: e.day, right: e.rating >= 3 });
    if (e.v === 1) {
      const day = dayKey(new Date(e.ts));
      const k = `${e.card_id}|${day}`;
      if (!seenV1.has(k)) { seenV1.add(k); firsts.push({ day, right: e.correct }); }
    }
  }
  const days = new Set(firsts.map((f) => f.day));
  const parts: string[] = [];
  if (firsts.length >= 100 && days.size >= 14) {
    const weeks = new Map<string, { n: number; r: number }>();
    for (const f of firsts) {
      const d = new Date(`${f.day}T12:00:00`);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
      const k = d.toISOString().slice(0, 10);
      const w = weeks.get(k) ?? { n: 0, r: 0 };
      w.n++; w.r += f.right ? 1 : 0;
      weeks.set(k, w);
    }
    const rows = [...weeks].filter(([, w]) => w.n >= 20).sort();
    parts.push(`<div class="fact"><h4>First-try rate by week</h4><p class="stat">${rows.map(([k, w]) => `Week of ${k}: ${Math.round((100 * w.r) / w.n)}% (${w.r}/${w.n})`).join('; ')}.</p>
      <p class="samp">Based on ${firsts.length} first answers over ${days.size} study days (weeks with at least 20 shown).</p></div>`);
  } else {
    parts.push(`<p class="muted small">First-try rate over time appears from 100 first answers over 14 study days. So far: ${firsts.length} first answers over ${days.size} study day${days.size === 1 ? '' : 's'}.</p>`);
  }
  const habit = new Map<string, Map<string, number>>();
  for (const e of evs) {
    if (e.v === 2 && e.kind === 'move' && e.habit && e.move_played) {
      const m = habit.get(e.card_id) ?? new Map<string, number>();
      m.set(e.move_played, (m.get(e.move_played) ?? 0) + 1);
      habit.set(e.card_id, m);
    }
  }
  const repeated = [...habit].map(([id, m]) => ({ id, total: [...m.values()].reduce((a, b) => a + b, 0), m }))
    .filter((h) => h.total >= 2).sort((a, b) => b.total - a.total);
  if (repeated.length >= 5) {
    parts.push(`<div class="fact"><h4>Most repeated habits</h4><p class="stat">${repeated.slice(0, 5).map((h) => {
      const c = ctx.byId.get(h.id);
      const [mv, n] = [...h.m].sort((a, b) => b[1] - a[1])[0];
      return c ? `${esc(sanOf(c.fen, mv))} again ${n}× (from your ${esc(c.occ[0].tc)} game, ${esc(c.occ[0].at)})` : `${n}× on a card no longer in the deck`;
    }).join('; ')}.</p><p class="samp">Showings where your wrong move was the move from your game. ${repeated.length} cards with 2 or more.</p></div>`);
  } else {
    parts.push(`<p class="muted small">Repeated habits appear when 5 cards have 2 or more habit showings. So far: ${repeated.length}.</p>`);
  }
  return parts.join('');
}
