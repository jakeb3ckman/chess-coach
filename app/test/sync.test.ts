import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64decode, b64encode, describe, monthOf, parseNdjson } from '../src/sync.ts';
import type { StoredEvent } from '../src/db.ts';

test('base64 round trip keeps UTF-8 (GitHub content encoding)', () => {
  const text = '{"id":"a","note":"♞ e4–e5 ✓"}\n';
  assert.equal(b64decode(b64encode(text)), text);
  // GitHub wraps base64 at 60 characters; line breaks must be ignored.
  const wrapped = b64encode(text.repeat(20)).replace(/(.{60})/g, '$1\n');
  assert.equal(b64decode(wrapped), text.repeat(20));
});

test('NDJSON: one event per line, damaged lines skipped, storage fields dropped', () => {
  const good = { id: 'e1', v: 2, card_id: 'c', ts: '2026-11-15T10:00:00.000Z', day: '2026-11-15', device: 'mac', kind: 'move', showing: 1, sched: false };
  const text = [JSON.stringify({ ...good, sent: 1 }), '{not json', '', JSON.stringify({ id: 'x' })].join('\n');
  const evs = parseNdjson(text);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].id, 'e1');
  assert.ok(!('sent' in evs[0]));
});

test('events go to the month file of their study day', () => {
  const e = { id: 'a', v: 2, card_id: 'c', ts: '2026-12-01T03:00:00.000Z', day: '2026-11-30', device: 'x', kind: 'move', showing: 1, sched: false, sent: 0 } as StoredEvent;
  assert.equal(monthOf(e), '2026-11');
});

test('error messages say what happened and that reviews are kept', () => {
  const auth = describe('auth', 'jakeb3ckman/chess-coach-progress', 3);
  assert.match(auth, /refused the token/);
  assert.match(auth, /3 review events are saved on this device/);
  assert.match(describe('access', 'me/repo', 1), /can't reach me\/repo/);
  assert.match(describe('public', 'me/repo', 0), /is public/);
  assert.match(describe('offline', 'me/repo', 2), /Offline\. 2 waiting/);
});
