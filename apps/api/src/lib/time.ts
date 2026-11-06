/** Calendar-day helpers in an IANA time zone (no tz library: Intl does the offset maths). */

function partsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` from UTC at `date`, in milliseconds (e.g. +05:30 → 19 800 000). */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The UTC instants where the calendar day containing `now` starts and ends in `timeZone`,
 * plus the day as YYYY-MM-DD. Invalid zones fall back to UTC.
 */
export function dayBoundsInZone(
  now: Date,
  timeZone: string,
): { start: Date; end: Date; day: string; timeZone: string } {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const p = partsIn(now, tz);
  const day = `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const midnightGuess = Date.UTC(p.year, p.month - 1, p.day);
  // Two passes handle a DST change between the guess and the real midnight.
  let start = midnightGuess - offsetMs(new Date(midnightGuess), tz);
  start = midnightGuess - offsetMs(new Date(start), tz);
  const nextGuess = Date.UTC(p.year, p.month - 1, p.day + 1);
  let end = nextGuess - offsetMs(new Date(nextGuess), tz);
  end = nextGuess - offsetMs(new Date(end), tz);
  return { start: new Date(start), end: new Date(end), day, timeZone: tz };
}
