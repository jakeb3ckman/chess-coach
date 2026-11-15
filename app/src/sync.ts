// Sync between devices through a private GitHub repository (spec section 6.2).
//
// Layout in the progress repo: log/{device}/{YYYY-MM}.ndjson, one review event per
// line. Each device only ever writes its own files, so devices never conflict.
//
// One sync:
//  1. GET the repository (checks token, access, and that it is private).
//  2. GET the whole file list in ONE request (git tree, recursive) with each
//     file's content hash; download only other devices' files whose hash changed
//     since the last sync; merge their events (ledger.mergeEvents).
//  3. Upload this device's outbox: per month, read its file, append the events
//     it doesn't have yet, write it back (with the file's sha, so a stale write
//     is refused, never silently overwritten). Events are marked sent only after
//     GitHub confirms the write. Nothing is ever deleted from the outbox early.
//
// Errors: 401 = token expired/revoked/mistyped; 404 on the repo = wrong name or
// the token doesn't include it; 403 = missing permission or rate limit; a failed
// fetch = offline. Training is never blocked; the outbox simply keeps growing.
import { getMeta, markSent, outbox, outboxCount, setMeta, type StoredEvent } from './db.ts';
import { dayKey } from './day.ts';
import { cleanEvents, mergeEvents, type LedgerCtx, type MergeResult } from './ledger.ts';

export const DEFAULT_API = 'https://api.github.com';
const LOG_PATH = /^log\/([^/]+)\/(\d{4}-\d{2})\.ndjson$/;

export interface SyncConfig {
  repo: string; // owner/name
  token: string;
  api?: string; // only changed for local testing
}

export type SyncState = 'off' | 'syncing' | 'ok' | 'offline' | 'auth' | 'access' | 'public' | 'ratelimit' | 'error';

export interface SyncStatus {
  state: SyncState;
  message: string;
  lastOk?: string; // ISO time of the last successful sync
  waiting: number; // events not yet uploaded
  pulled?: number;
  pushed?: number;
}

export class SyncError extends Error {
  kind: SyncState;
  constructor(kind: SyncState, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface SyncHost {
  ctx: () => LedgerCtx;
  device: () => string;
  onMerged: (res: MergeResult) => void | Promise<void>;
  onStatus: (s: SyncStatus) => void;
}

// ---- encoding (GitHub sends and expects base64 of the UTF-8 bytes)
export function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64decode(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function parseNdjson(text: string) {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* a damaged line is skipped, the rest still count */ }
  }
  return cleanEvents(out);
}

/** Month file an event belongs to: its study day's month. */
export function monthOf(e: StoredEvent): string {
  return (e.v === 2 ? e.day : dayKey(new Date(e.ts))).slice(0, 7);
}

function eventLine(e: StoredEvent): string {
  const { sent: _sent, ...rest } = e;
  return JSON.stringify(rest);
}

export function describe(kind: SyncState, repo: string, waiting: number): string {
  const kept = `${waiting} review event${waiting === 1 ? ' is' : 's are'} saved on this device and will upload when sync works again.`;
  switch (kind) {
    case 'auth': return `Sync stopped: GitHub refused the token (expired, revoked or mistyped). ${kept} Tap to enter a new token.`;
    case 'access': return `Sync stopped: the token can't reach ${repo}. Check the repository name, and that the token includes this repository with "Contents: Read and write". ${kept}`;
    case 'public': return `Sync stopped: ${repo} is public. Reviews only sync to a private repository. Make it private on GitHub (Settings → Danger Zone → Change visibility). ${kept}`;
    case 'ratelimit': return `GitHub asked to slow down; sync will retry later. ${kept}`;
    case 'offline': return `Offline. ${waiting} waiting to upload.`;
    default: return `Sync error. ${kept}`;
  }
}

export class Sync {
  private running: Promise<SyncStatus> | null = null;
  private again = false;
  private sinceSync = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  status: SyncStatus = { state: 'off', message: 'Sync is not set up.', waiting: 0 };

  private host: SyncHost;
  constructor(host: SyncHost) {
    this.host = host;
  }

  async config(): Promise<SyncConfig | undefined> {
    const c = await getMeta<SyncConfig>(this.host.ctx().db, 'sync');
    return c && c.repo && c.token ? c : undefined;
  }

  async saveConfig(c: SyncConfig | null) {
    const db = this.host.ctx().db;
    await setMeta(db, 'sync', c);
    await setMeta(db, 'sync_known', {}); // re-read the other devices' files with the new settings
    await setMeta(db, 'sync_branch', null);
  }

  /** Run a sync now (or join the one running, then run once more). */
  run(): Promise<SyncStatus> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.once().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.run();
      }
    });
    return this.running;
  }

  /** Called after every saved answer: sync after 10 events, or 20 s after the last one. */
  noteEvent() {
    this.sinceSync++;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.sinceSync >= 10) void this.run();
    else this.debounce = setTimeout(() => void this.run(), 20_000);
  }

  private setStatus(s: SyncStatus) {
    this.status = s;
    this.host.onStatus(s);
  }

  private async once(): Promise<SyncStatus> {
    const db = this.host.ctx().db;
    const cfg = await this.config();
    const lastOk = await getMeta<string>(db, 'sync_last_ok');
    if (!cfg) {
      const s: SyncStatus = { state: 'off', message: 'Sync is not set up.', waiting: await outboxCount(db), lastOk };
      this.setStatus(s);
      return s;
    }
    this.setStatus({ ...this.status, state: 'syncing', message: 'Syncing…' });
    this.sinceSync = 0;
    try {
      const pulled = await this.pull(cfg);
      const pushed = await this.push(cfg);
      const now = new Date().toISOString();
      await setMeta(db, 'sync_last_ok', now);
      const s: SyncStatus = { state: 'ok', message: 'Synced.', lastOk: now, waiting: await outboxCount(db), pulled, pushed };
      this.setStatus(s);
      return s;
    } catch (e) {
      const kind = e instanceof SyncError ? e.kind : 'error';
      const waiting = await outboxCount(db);
      const s: SyncStatus = {
        state: kind, waiting, lastOk,
        message: kind === 'error' ? `Sync error: ${(e as Error).message}. ${waiting} waiting to upload.` : describe(kind, cfg.repo, waiting),
      };
      this.setStatus(s);
      return s;
    }
  }

  private async gh(cfg: SyncConfig, path: string, init: RequestInit = {}): Promise<Response> {
    let r: Response;
    try {
      r = await fetch(`${cfg.api || DEFAULT_API}${path}`, {
        ...init,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch {
      throw new SyncError('offline', 'offline');
    }
    if (r.status === 401) throw new SyncError('auth', 'bad credentials');
    if ((r.status === 403 || r.status === 429)
      && (r.headers.get('x-ratelimit-remaining') === '0' || r.headers.has('retry-after') || r.status === 429)) {
      throw new SyncError('ratelimit', 'rate limited');
    }
    return r;
  }

  private async branch(cfg: SyncConfig): Promise<string> {
    const db = this.host.ctx().db;
    const r = await this.gh(cfg, `/repos/${cfg.repo}`);
    if (r.status === 404 || r.status === 403) throw new SyncError('access', 'no access');
    if (!r.ok) throw new SyncError('error', `GitHub answered ${r.status}`);
    const info = await r.json() as { private: boolean; default_branch: string };
    if (!info.private) throw new SyncError('public', 'public repository');
    await setMeta(db, 'sync_branch', info.default_branch);
    return info.default_branch;
  }

  /** Download other devices' changed files and merge their events. */
  private async pull(cfg: SyncConfig): Promise<number> {
    const db = this.host.ctx().db;
    const branch = await this.branch(cfg);
    const r = await this.gh(cfg, `/repos/${cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (r.status === 404 || r.status === 409) return 0; // empty repository: nothing to pull yet
    if (r.status === 403) throw new SyncError('access', 'no access');
    if (!r.ok) throw new SyncError('error', `GitHub answered ${r.status} for the file list`);
    const tree = await r.json() as { tree: { path: string; type: string; sha: string }[] };
    const known = (await getMeta<Record<string, string>>(db, 'sync_known')) ?? {};
    const me = this.host.device();
    const events = [];
    const seen: Record<string, string> = {};
    for (const item of tree.tree) {
      const m = LOG_PATH.exec(item.path);
      if (item.type !== 'blob' || !m || m[1] === me) continue;
      if (known[item.path] === item.sha) continue;
      const b = await this.gh(cfg, `/repos/${cfg.repo}/git/blobs/${item.sha}`);
      if (!b.ok) throw new SyncError(b.status === 403 || b.status === 404 ? 'access' : 'error', `blob ${b.status}`);
      const blob = await b.json() as { content: string };
      events.push(...parseNdjson(b64decode(blob.content)));
      seen[item.path] = item.sha;
    }
    let added = 0;
    if (events.length) {
      const res = await mergeEvents(this.host.ctx(), events, 1);
      added = res.added;
      if (res.added) await this.host.onMerged(res);
    }
    if (Object.keys(seen).length) await setMeta(db, 'sync_known', { ...known, ...seen });
    return added;
  }

  /** Append this device's outbox to its monthly files. */
  private async push(cfg: SyncConfig): Promise<number> {
    const db = this.host.ctx().db;
    const branch = (await getMeta<string>(db, 'sync_branch')) ?? 'main';
    const pending = await outbox(db);
    if (!pending.length) return 0;
    const byMonth = new Map<string, StoredEvent[]>();
    for (const e of pending) byMonth.set(monthOf(e), [...(byMonth.get(monthOf(e)) ?? []), e]);
    const me = this.host.device();
    let pushed = 0;
    for (const month of [...byMonth.keys()].sort()) {
      const evs = byMonth.get(month)!.sort((a, b) => (a.ts < b.ts ? -1 : 1));
      const path = `log/${me}/${month}.ndjson`;
      for (let attempt = 0; ; attempt++) {
        const g = await this.gh(cfg, `/repos/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
        let sha: string | undefined;
        let text = '';
        if (g.ok) {
          const f = await g.json() as { sha: string; content: string };
          sha = f.sha;
          text = b64decode(f.content);
        } else if (g.status === 403) {
          throw new SyncError('access', 'no access');
        } else if (g.status !== 404) {
          throw new SyncError('error', `GitHub answered ${g.status} reading ${path}`);
        }
        const have = new Set(parseNdjson(text).map((e) => e.id));
        const add = evs.filter((e) => !have.has(e.id));
        if (add.length) {
          const body = (text && !text.endsWith('\n') ? text + '\n' : text) + add.map(eventLine).join('\n') + '\n';
          const p = await this.gh(cfg, `/repos/${cfg.repo}/contents/${path}`, {
            method: 'PUT',
            body: JSON.stringify({ message: `reviews: ${me} ${month} (+${add.length})`, content: b64encode(body), branch, ...(sha ? { sha } : {}) }),
          });
          if ((p.status === 409 || p.status === 422) && attempt < 2) continue; // the file changed meanwhile: read again
          if (p.status === 403 || p.status === 404) throw new SyncError('access', 'no write access');
          if (!p.ok) throw new SyncError('error', `GitHub answered ${p.status} writing ${path}`);
        }
        await markSent(db, evs.map((e) => e.id)); // only after GitHub confirmed the write
        pushed += add.length;
        break;
      }
    }
    return pushed;
  }
}
