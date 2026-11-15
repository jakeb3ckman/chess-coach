// Bringing review events in from outside this device (a backup file now, the
// other device through sync in 2.3). One rule for both: an event id is stored
// once; every card that got new events has its schedule rebuilt from all of its
// events (replayCard), so the result does not depend on arrival order.
import { eventsForCard, existingIds, saveAll } from './db.ts';
import { replayCard, type CardState, type Scheduler } from './scheduler.ts';
import type { AppCard, ReviewEvent } from './types.ts';

export interface LedgerCtx {
  db: IDBDatabase;
  sched: Scheduler;
  byId: Map<string, AppCard>;
  states: Map<string, CardState>;
}

/** Keep only well-formed events; drop storage-only fields. */
export function cleanEvents(raw: unknown): ReviewEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewEvent[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const e = { ...(r as Record<string, unknown>) };
    delete e.sent;
    const ok = typeof e.id === 'string' && (e.v === 1 || e.v === 2) && typeof e.card_id === 'string'
      && typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts as string));
    if (ok) out.push(e as unknown as ReviewEvent);
  }
  return out;
}

export interface MergeResult {
  added: number;
  already: number;
  cards: Set<string>;
  days: Set<string>;
}

/** Store events not seen before and rebuild the schedules they affect.
 * sent=1 for events that are already in the progress repo (pulled by sync),
 * sent=0 for events that still need uploading (e.g. restored from a backup). */
export async function mergeEvents(ctx: LedgerCtx, incoming: ReviewEvent[], sent: 0 | 1): Promise<MergeResult> {
  const unique = new Map(incoming.map((e) => [e.id, e]));
  const have = await existingIds(ctx.db, [...unique.keys()]);
  const fresh = [...unique.values()].filter((e) => !have.has(e.id));
  const res: MergeResult = { added: fresh.length, already: unique.size - fresh.length, cards: new Set(), days: new Set() };
  if (!fresh.length) return res;
  await saveAll(ctx.db, fresh, [], sent);
  for (const e of fresh) {
    if (e.v === 2) res.days.add(e.day);
    if (!(e.v === 2 && e.kind === 'set')) res.cards.add(e.card_id);
  }
  const states: CardState[] = [];
  for (const id of res.cards) {
    const evs = await eventsForCard(ctx.db, id);
    const moves = new Set((ctx.byId.get(id)?.occ ?? []).map((o) => o.move));
    const st = replayCard(ctx.sched, evs, moves);
    if (st) states.push(st);
  }
  await saveAll(ctx.db, [], states);
  for (const st of states) ctx.states.set(st.card_id, st);
  return res;
}
