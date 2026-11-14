import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, getScheduler, Rating, replayCard, reviveFsrs, State, type CardState } from '../src/scheduler.ts';
import type { ReviewEvent } from '../src/types.ts';

const ev = (id: string, ts: string, rating: number, device = 'iphone-1'): ReviewEvent => ({
  id, v: 1, card_id: 'card1', ts, device, move_played: 'e2e4', correct: rating !== Rating.Again, rating, ms_to_answer: 900,
});

const history = [
  ev('a', '2026-11-14T09:00:00.000Z', Rating.Again),
  ev('b', '2026-11-14T09:01:30.000Z', Rating.Good),
  ev('c', '2026-11-14T09:15:00.000Z', Rating.Good),
  ev('d', '2026-11-16T08:00:00.000Z', Rating.Good, 'mac-1'),
  ev('e', '2026-11-25T20:00:00.000Z', Rating.Again),
];

test('wrong answer: card comes back in 1 minute (learning step)', async () => {
  const s = await getScheduler();
  const st = applyEvent(s, undefined, history[0]);
  assert.equal(st.fsrs.state, State.Learning);
  assert.equal(st.fsrs.dueAt.toISOString(), '2026-11-14T09:01:00.000Z');
  assert.equal(st.introduced_at, history[0].ts);
});

test('replaying events gives exactly the state built review by review', async () => {
  const s = await getScheduler();
  let inc: CardState | undefined;
  for (const e of history) inc = applyEvent(s, inc, e);
  const shuffled = [history[3], history[0], history[4], history[2], history[1]];
  const replayed = replayCard(s, shuffled);
  assert.deepEqual(replayed, inc);
});

test('an event received twice counts once', async () => {
  const s = await getScheduler();
  const once = replayCard(s, history);
  const twice = replayCard(s, [...history, history[1], history[3]]);
  assert.deepEqual(twice, once);
  assert.equal(twice?.n_events, history.length);
});

test('state survives a JSON round trip (dates revived)', async () => {
  const s = await getScheduler();
  const st = replayCard(s, history.slice(0, 3))!;
  const back = JSON.parse(JSON.stringify(st)) as CardState;
  back.fsrs = reviveFsrs(back.fsrs);
  assert.deepEqual(applyEvent(s, back, history[3]), applyEvent(s, st, history[3]));
});
