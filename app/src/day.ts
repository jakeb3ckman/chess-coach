// Study days start at 4:00 a.m. local time, so a 1 a.m. session still counts as "today".
export const DAY_ROLLOVER_HOUR = 4;

export function dayKey(d: Date, rolloverHour = DAY_ROLLOVER_HOUR): string {
  const t = new Date(d.getTime() - rolloverHour * 3600_000);
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const day = String(t.getDate()).padStart(2, '0');
  return `${t.getFullYear()}-${m}-${day}`;
}

/** The moment the current study day ends (next 4:00 a.m. local). */
export function dayEnd(d: Date, rolloverHour = DAY_ROLLOVER_HOUR): Date {
  const e = new Date(d.getTime());
  e.setHours(rolloverHour, 0, 0, 0);
  if (e.getTime() <= d.getTime()) e.setDate(e.getDate() + 1);
  return e;
}

/** "tomorrow", "in 2 days", "in 54 days", counted in study days. */
export function returnText(due: Date, now: Date): string {
  const n = Math.round((Date.parse(dayKey(due)) - Date.parse(dayKey(now))) / 86_400_000);
  if (n <= 0) return 'later today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}
