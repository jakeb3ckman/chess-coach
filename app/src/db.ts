// On-device storage (IndexedDB). Opening the app reads `states` only: one small
// record per card ever reviewed, so it does not get slower as reviews pile up.
// `events` is the append-only review log; events with sent=0 are the outbox
// that sync (2.3) uploads. Nothing here ever deletes an unsent event.
import type { ReviewEvent } from './types.ts';
import { reviveFsrs, type CardState } from './scheduler.ts';

const DB_NAME = 'chess-coach';
const DB_VERSION = 1;

export interface StoredEvent extends ReviewEvent {
  sent: 0 | 1;
}

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
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('states', { keyPath: 'card_id' });
    const ev = db.createObjectStore('events', { keyPath: 'id' });
    ev.createIndex('sent', 'sent');
    db.createObjectStore('meta');
  };
  return req(r);
}

export async function loadStates(db: IDBDatabase): Promise<Map<string, CardState>> {
  const tx = db.transaction('states', 'readonly');
  const all = (await req(tx.objectStore('states').getAll())) as CardState[];
  return new Map(all.map((s) => [s.card_id, { ...s, fsrs: reviveFsrs(s.fsrs) }]));
}

/** Save the review event and the card's new state together, or neither. */
export async function saveReview(db: IDBDatabase, ev: ReviewEvent, state: CardState): Promise<void> {
  const tx = db.transaction(['events', 'states'], 'readwrite');
  tx.objectStore('events').add({ ...ev, sent: 0 } satisfies StoredEvent);
  tx.objectStore('states').put(state);
  await done(tx);
}

export async function outboxCount(db: IDBDatabase): Promise<number> {
  const tx = db.transaction('events', 'readonly');
  return req(tx.objectStore('events').index('sent').count(IDBKeyRange.only(0)));
}

export async function allEvents(db: IDBDatabase): Promise<StoredEvent[]> {
  const tx = db.transaction('events', 'readonly');
  return (await req(tx.objectStore('events').getAll())) as StoredEvent[];
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
