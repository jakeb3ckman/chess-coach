import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, getScheduler, previewDue, Rating, replayCard, reviveFsrs, schedRating, type CardState } from '../src/scheduler.ts';
import type { ReviewEvent, ReviewEventV1, ReviewEventV2 } from '../src/types.ts';

const DAY = 86_400_000;
const v1 = (id: string, ts: string, rating: number, move = 'e2e4'): ReviewEventV1 => ({
  id, v: 1, card_id: 'card1', ts, device: 'iphone-1', move_played: move, correct: rating !== Rating.Again, rating, ms_to_answer: 900,
});
const v2 = (id: string, ts: string, day: string, extra: Partial<ReviewEventV2>): ReviewEventV2 => ({
  id, v: 2, card_id: 'card1', ts, day, device: 'iphone-1', kind: 'move', showing: 1, sched: false, ...extra,
});

test('new card: miss -> back in 1 day; right -> 2 days; too easy -> much later', async () => {
  const s = await getScheduler();
  const now = new Date('2026-11-14T10:00:00Z');
  assert.equal(previewDue(s, undefined, Rating.Again, now, 'c').getTime() - now.getTime(), DAY);
  assert.equal(previewDue(s, undefined, Rating.Good, now, 'c').getTime() - now.getTime(), 2 * DAY);
  assert.ok(previewDue(s, undefined, Rating.Easy, now, 'c').getTime() - now.getTime() > 7 * DAY);
});

test('known card missed later: back in 1 day', async () => {
  const s = await getScheduler();
  let st: CardState | undefined;
  let t = Date.parse('2026-11-01T10:00:00Z');
  for (const r of [Rating.Good, Rating.Good]) {
    st = applyEvent(s, st, v2(`g${t}`, new Date(t).toISOString(), 'x', { kind: 'grade', sched: true, rating: r }), r);
    t = st.fsrs.dueAt.getTime();
  }
  const missAt = new Date(t);
  assert.equal(previewDue(s, st, Rating.Again, missAt, 'card1').getTime() - missAt.getTime(), DAY);
});

test('only the first showing of the day moves the schedule (format 2)', async () => {
  const s = await getScheduler();
  const day1 = [
    v2('a', '2026-11-14T10:00:00.000Z', '2026-11-14', { correct: false, sched: true, rating: Rating.Again, status_after: 'missed' }),
    v2('b', '2026-11-14T10:03:00.000Z', '2026-11-14', { showing: 2, correct: true, status_after: 'unsure' }),
    v2('c', '2026-11-14T10:09:00.000Z', '2026-11-14', { showing: 3, correct: true, status_after: 'known' }),
  ];
  const drilled = replayCard(s, day1)!;
  const onlyFirst = replayCard(s, [day1[0]])!;
  assert.deepEqual(drilled.fsrs, onlyFirst.fsrs);
  assert.equal(drilled.n_events, 3);
  assert.equal(drilled.fsrs.dueAt.toISOString(), '2026-11-15T10:00:00.000Z');
});

test('format 1 reviews: the first answer of each day counts, later ones are drilling', async () => {
  const s = await getScheduler();
  const evs = [
    v1('a', '2026-11-12T09:00:00.000Z', Rating.Again),
    v1('b', '2026-11-12T09:01:30.000Z', Rating.Good),
    v1('c', '2026-11-12T09:15:00.000Z', Rating.Good),
    v1('d', '2026-11-13T09:00:00.000Z', Rating.Good),
  ];
  const all = replayCard(s, evs)!;
  const firsts = replayCard(s, [evs[0], evs[3]])!;
  assert.deepEqual(all.fsrs, firsts.fsrs);
  assert.equal(schedRating(evs[1], false), null);
  assert.equal(all.introduced_at, evs[0].ts);
});

test('replay ignores order and duplicate events', async () => {
  const s = await getScheduler();
  const evs: ReviewEvent[] = [
    v2('a', '2026-11-14T10:00:00.000Z', '2026-11-14', { correct: true, status_after: 'known' }),
    v2('b', '2026-11-14T10:00:05.000Z', '2026-11-14', { kind: 'grade', sched: true, rating: Rating.Good }),
    v2('c', '2026-11-16T10:00:00.000Z', '2026-11-16', { correct: false, sched: true, rating: Rating.Again, habit: true }),
  ];
  const a = replayCard(s, evs)!;
  const b = replayCard(s, [evs[2], evs[0], evs[1], evs[2]])!;
  assert.deepEqual(a, b);
  assert.equal(a.habit, 1);
});

test('habit in format-1 reviews: a wrong move equal to a game move', async () => {
  const s = await getScheduler();
  const st = replayCard(s, [v1('a', '2026-11-12T09:00:00.000Z', Rating.Again, 'f3e3')], new Set(['f3e3']))!;
  assert.equal(st.habit, 1);
});

test('state survives a JSON round trip (dates revived)', async () => {
  const s = await getScheduler();
  const e1 = v2('a', '2026-11-14T10:00:00.000Z', '2026-11-14', { correct: false, sched: true, rating: Rating.Again });
  const st = applyEvent(s, undefined, e1, Rating.Again);
  const back = JSON.parse(JSON.stringify(st)) as CardState;
  back.fsrs = reviveFsrs(back.fsrs);
  const e2 = v2('b', '2026-11-15T10:00:00.000Z', '2026-11-15', { kind: 'grade', sched: true, rating: Rating.Good });
  assert.deepEqual(applyEvent(s, back, e2, Rating.Good), applyEvent(s, st, e2, Rating.Good));
});
