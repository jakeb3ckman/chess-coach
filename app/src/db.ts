// On-device storage (IndexedDB).
//  states  one record per card ever shown: its current FSRS schedule. Opening the
//          app reads these, never the whole review log, so it doesn't slow down
//          as reviews pile up.
//  events  the append-only review log. sent=0 marks the outbox for sync (2.3).
//          Nothing here ever deletes or edits an event.
//  sets    one record per study day: the day's cards and their statuses.
//  meta    device name, schema version, migration backup.
import type { ReviewEvent } from './types.ts';
import { reviveFsrs, type CardState } from './scheduler.ts';
import type { DaySet } from './session.ts';

const DB_NAME = 'chess-coach';
export const DB_VERSION = 2; // 1 = milestone 2.2; 2 = rework (adds `sets`)

export type StoredEvent = ReviewEvent & { sent: 0 | 1 };

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export async function openDb(): Promise<IDBDatabase> {
  const r = indexedDB.open(DB_NAME, DB_VERSION);
  r.onupgradeneeded = (e) => {
    const db = r.result;
    if (e.oldVersion < 1) {
      db.createObjectStore('states', { keyPath: 'card_id' });
      const ev = db.createObjectStore('events', { keyPath: 'id' });
      ev.createIndex('sent', 'sent');
      db.createObjectStore('meta');
    }
    if (e.oldVersion < 2) db.createObjectStore('sets', { keyPath: 'day' });
    // Existing states/events are left untouched here; main.ts recomputes the
    // states from the events under the new rules (schema migration 1 -> 2).
  };
  return req(r);
}

export async function loadStates(db: IDBDatabase): Promise<Map<string, CardState>> {
  const tx = db.transaction('states', 'readonly');
  const all = (await req(tx.objectStore('states').getAll())) as CardState[];
  return new Map(all.map((s) => [s.card_id, { ...s, fsrs: reviveFsrs(s.fsrs) }]));
}

/** Save events, changed card states and the day's set together, or nothing. */
export async function saveAll(db: IDBDatabase, events: ReviewEvent[], states: CardState[], set?: DaySet): Promise<void> {
  const tx = db.transaction(['events', 'states', 'sets'], 'readwrite');
  for (const ev of events) tx.objectStore('events').add({ ...ev, sent: 0 });
  for (const st of states) tx.objectStore('states').put(st);
  if (set) tx.objectStore('sets').put(set);
  await done(tx);
}

export async function loadSet(db: IDBDatabase, day: string): Promise<DaySet | undefined> {
  const tx = db.transaction('sets', 'readonly');
  return (await req(tx.objectStore('sets').get(day))) as DaySet | undefined;
}

export async function outboxCount(db: IDBDatabase): Promise<number> {
  const tx = db.transaction('events', 'readonly');
  return req(tx.objectStore('events').index('sent').count(IDBKeyRange.only(0)));
}

export async function allEvents(db: IDBDatabase): Promise<StoredEvent[]> {
  const tx = db.transaction('events', 'readonly');
  return (await req(tx.objectStore('events').getAll())) as StoredEvent[];
}

/** Replace every card state at once (migration), keeping a copy of the old ones. */
export async function replaceStates(
  db: IDBDatabase, states: CardState[], old: CardState[], backupKey: string, schema: number,
): Promise<void> {
  const tx = db.transaction(['states', 'meta'], 'readwrite');
  const store = tx.objectStore('states');
  tx.objectStore('meta').put({ at: new Date().toISOString(), states: old }, backupKey);
  store.clear();
  for (const st of states) store.put(st);
  tx.objectStore('meta').put(schema, 'schema');
  await done(tx);
}

export async function getMeta<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  const tx = db.transaction('meta', 'readonly');
  return (await req(tx.objectStore('meta').get(key))) as T | undefined;
}

export async function setMeta(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await done(tx);
}
