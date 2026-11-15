// On-device storage (IndexedDB).
//  states  one record per card ever shown: its current FSRS schedule. Opening the
//          app reads these and today's events, never the whole review log, so it
//          doesn't slow down as reviews pile up.
//  events  the append-only review log, indexed by card and by study day.
//          sent=0 marks the outbox: events not yet uploaded by sync.
//          Nothing here ever deletes or edits an event (except flipping sent to 1).
//  sets    (format 2 only, kept for history) one record per day; sets are now
//          derived from events (session.ts).
//  meta    device name, schema version, sync settings, migration backups.
import type { ReviewEvent } from './types.ts';
import { reviveFsrs, type CardState } from './scheduler.ts';

const DB_NAME = 'chess-coach';
// 1 = milestone 2.2; 2 = rework (adds `sets`); 3 = event indexes by card and day.
export const DB_VERSION = 3;

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
    const tx = r.transaction!;
    if (e.oldVersion < 1) {
      db.createObjectStore('states', { keyPath: 'card_id' });
      db.createObjectStore('events', { keyPath: 'id' }).createIndex('sent', 'sent');
      db.createObjectStore('meta');
    }
    if (e.oldVersion < 2) db.createObjectStore('sets', { keyPath: 'day' });
    if (e.oldVersion < 3) {
      const ev = tx.objectStore('events');
      ev.createIndex('card_id', 'card_id');
      ev.createIndex('day', 'day'); // format-2 events carry their study day
    }
  };
  return req(r);
}

export async function loadStates(db: IDBDatabase): Promise<Map<string, CardState>> {
  const tx = db.transaction('states', 'readonly');
  const all = (await req(tx.objectStore('states').getAll())) as CardState[];
  return new Map(all.map((s) => [s.card_id, { ...s, fsrs: reviveFsrs(s.fsrs) }]));
}

/** Save new events and changed card states together, or nothing. */
export async function saveAll(db: IDBDatabase, events: ReviewEvent[], states: CardState[], sent: 0 | 1 = 0): Promise<void> {
  const tx = db.transaction(['events', 'states'], 'readwrite');
  for (const ev of events) tx.objectStore('events').put({ ...ev, sent });
  for (const st of states) tx.objectStore('states').put(st);
  await done(tx);
}

export async function eventsForDay(db: IDBDatabase, day: string): Promise<StoredEvent[]> {
  const tx = db.transaction('events', 'readonly');
  return (await req(tx.objectStore('events').index('day').getAll(IDBKeyRange.only(day)))) as StoredEvent[];
}

export async function eventsForCard(db: IDBDatabase, cardId: string): Promise<StoredEvent[]> {
  const tx = db.transaction('events', 'readonly');
  return (await req(tx.objectStore('events').index('card_id').getAll(IDBKeyRange.only(cardId)))) as StoredEvent[];
}

/** Which of these event ids are already stored. */
export async function existingIds(db: IDBDatabase, ids: string[]): Promise<Set<string>> {
  const tx = db.transaction('events', 'readonly');
  const store = tx.objectStore('events');
  const found = await Promise.all(ids.map((id) => req(store.getKey(id))));
  return new Set(found.filter((k) => k !== undefined) as string[]);
}

export async function outbox(db: IDBDatabase): Promise<StoredEvent[]> {
  const tx = db.transaction('events', 'readonly');
  return (await req(tx.objectStore('events').index('sent').getAll(IDBKeyRange.only(0)))) as StoredEvent[];
}

export async function outboxCount(db: IDBDatabase): Promise<number> {
  const tx = db.transaction('events', 'readonly');
  return req(tx.objectStore('events').index('sent').count(IDBKeyRange.only(0)));
}

export async function markSent(db: IDBDatabase, ids: string[]): Promise<void> {
  const tx = db.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  for (const id of ids) {
    const r = store.get(id);
    r.onsuccess = () => {
      if (r.result && r.result.sent !== 1) store.put({ ...r.result, sent: 1 });
    };
  }
  await done(tx);
}

export async function allEvents(db: IDBDatabase): Promise<StoredEvent[]> {
  const tx = db.transaction('events', 'readonly');
  return (await req(tx.objectStore('events').getAll())) as StoredEvent[];
}

export async function loadLegacySet(db: IDBDatabase, day: string): Promise<{ cards: string[]; created_at: string } | undefined> {
  const tx = db.transaction('sets', 'readonly');
  return (await req(tx.objectStore('sets').get(day))) as { cards: string[]; created_at: string } | undefined;
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
