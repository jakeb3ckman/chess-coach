// Daily queue (spec section 6.1). Pure functions, no storage, so they are tested directly.
import type { AppCard } from './types.ts';
import { isLearning, type CardState } from './scheduler.ts';

export const NEW_PER_DAY = 10;
export const DAY_ROLLOVER_HOUR = 4; // a 1 a.m. session still counts as "today"

/** Local calendar day, shifted so the day starts at 4:00 a.m. */
export function dayKey(d: Date, rolloverHour = DAY_ROLLOVER_HOUR): string {
  const t = new Date(d.getTime() - rolloverHour * 3600_000);
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const day = String(t.getDate()).padStart(2, '0');
  return `${t.getFullYear()}-${m}-${day}`;
}

export interface Queue {
  due: AppCard[]; // reviews and learning cards due now, earliest first
  fresh: AppCard[]; // new cards still allowed today, in the approved order
  newToday: number; // new cards already introduced today
  later: { card: AppCard; dueAt: Date }[]; // learning cards due later today, soonest first
}

export function buildQueue(
  cards: AppCard[],
  states: Map<string, CardState>,
  now: Date,
  newPerDay = NEW_PER_DAY,
): Queue {
  const today = dayKey(now);
  let newToday = 0;
  for (const st of states.values()) if (dayKey(new Date(st.introduced_at)) === today) newToday++;

  const due: { card: AppCard; dueAt: Date }[] = [];
  const later: { card: AppCard; dueAt: Date }[] = [];
  const fresh: AppCard[] = [];
  const allowed = Math.max(0, newPerDay - newToday);
  for (const card of cards) {
    const st = states.get(card.id);
    if (!st) {
      if (fresh.length < allowed) fresh.push(card);
      continue;
    }
    const dueAt = st.fsrs.dueAt;
    if (dueAt.getTime() <= now.getTime()) due.push({ card, dueAt });
    else if (isLearning(st) && dayKey(dueAt) === today) later.push({ card, dueAt });
  }
  due.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  later.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  return { due: due.map((d) => d.card), fresh, newToday, later };
}

/** Next card to show: anything due first, then a new card. */
export function nextCard(q: Queue): AppCard | undefined {
  return q.due[0] ?? q.fresh[0];
}
