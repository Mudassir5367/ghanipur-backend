/**
 * Timezone-aware day/month ranges (§50). Report bucketing uses the shop's configured
 * timezone so "today" means the shop's local day, not UTC. Correct for no-DST zones
 * like Asia/Karachi; for DST zones the offset is sampled at the range start.
 */

function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - instant.getTime();
}

function boundary(y: number, m: number, d: number, timeZone: string): Date {
  const approx = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const off = tzOffsetMs(approx, timeZone);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - off);
}

export interface DateRange { start: Date; end: Date }

/** Range for a single YYYY-MM-DD in the given timezone. Defaults to today. */
export function dayRange(dateStr: string | undefined, timeZone: string): DateRange {
  const base = dateStr ? new Date(`${dateStr}T00:00:00Z`) : new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = fmt.format(base).split('-').map(Number);
  const start = boundary(y!, m!, d!, timeZone);
  const end = new Date(boundary(y!, m!, d! + 1, timeZone).getTime() - 1);
  return { start, end };
}

/** Range for a YYYY-MM month in the given timezone. Defaults to current month. */
export function monthRange(monthStr: string | undefined, timeZone: string): DateRange {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' });
  const [yStr, mStr] = (monthStr ?? fmt.format(now)).split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const start = boundary(y, m, 1, timeZone);
  const end = new Date(boundary(y, m + 1, 1, timeZone).getTime() - 1);
  return { start, end };
}

/** Named ranges for the dashboard (§50). */
export function namedRange(range: string | undefined, timeZone: string): DateRange {
  const today = dayRange(undefined, timeZone);
  switch (range) {
    case 'week': {
      const start = new Date(today.start.getTime() - 6 * 24 * 3600 * 1000);
      return { start, end: today.end };
    }
    case 'month':
      return monthRange(undefined, timeZone);
    case 'yesterday': {
      const y = new Date(today.start.getTime() - 24 * 3600 * 1000);
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
      return dayRange(fmt.format(y), timeZone);
    }
    case 'today':
    default:
      return today;
  }
}
