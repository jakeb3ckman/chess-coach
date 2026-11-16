// Which new cards a set may take (2.5.0): All, White, Black, or one opening
// group. Due reviews are never filtered. Pure functions, tested directly.
import type { AppCard } from './types.ts';

/** 'all' | 'white' | 'black' | 'o:<colour>:<opening group name>' */
export type NewFilter = string;

export function filterOk(f: NewFilter): (c: AppCard) => boolean {
  if (f === 'white' || f === 'black') return (c) => c.color === f;
  if (f.startsWith('o:')) {
    const [, color, ...rest] = f.split(':');
    const name = rest.join(':'); // group names can contain ':'
    return (c) => c.color === color && c.opening === name;
  }
  return () => true;
}

export interface FilterOption { value: NewFilter; label: string; fresh: number; group?: 'white' | 'black' }

/** All, White, Black, then every opening group that still has new cards (most first). */
export function filterOptions(cards: AppCard[], started: (id: string) => boolean): FilterOption[] {
  const fresh = cards.filter((c) => !started(c.id));
  const n = (f: NewFilter) => fresh.filter(filterOk(f)).length;
  const groups = new Map<string, number>();
  for (const c of fresh) {
    if (!c.opening) continue;
    const k = `o:${c.color}:${c.opening}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  const opts: FilterOption[] = [
    { value: 'all', label: 'All', fresh: fresh.length },
    { value: 'white', label: 'White', fresh: n('white') },
    { value: 'black', label: 'Black', fresh: n('black') },
  ];
  for (const [k, v] of [...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const [, color, ...rest] = k.split(':');
    opts.push({ value: k, label: rest.join(':'), fresh: v, group: color as 'white' | 'black' });
  }
  return opts;
}
