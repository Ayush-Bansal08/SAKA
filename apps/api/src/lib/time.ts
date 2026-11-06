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

/** Wall-clock hour and minute at `now` in `timeZone`. Invalid zones → UTC. */
export function localTimeIn(now: Date, timeZone: string): { hour: number; minute: number } {
  const p = partsIn(now, isValidTimeZone(timeZone) ? timeZone : 'UTC');
  return { hour: p.hour, minute: p.minute };
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** UTC instant of a local wall-clock time in `timeZone` (two passes absorb DST changes). */
function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return t;
}

/**
 * Next run of a schedule ("every day at 09:00", "every week on mon at 08:30") strictly after
 * `now`, in the user's time zone. Weekly without a day keeps today's weekday. Invalid zones → UTC.
 */
export function nextLocalRun(
  now: Date,
  timeZone: string,
  atLocalTime: string,
  every: 'day' | 'week',
  dayOfWeek?: string | null,
): Date {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const [hour, minute] = atLocalTime.split(':').map(Number) as [number, number];
  const p = partsIn(now, tz);
  const todayIdx = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const target =
    every === 'week'
      ? dayOfWeek && (WEEKDAYS as readonly string[]).includes(dayOfWeek)
        ? WEEKDAYS.indexOf(dayOfWeek as (typeof WEEKDAYS)[number])
        : todayIdx
      : null;
  for (let add = 0; add <= 8; add++) {
    if (target !== null && (todayIdx + add) % 7 !== target) continue;
    const t = localToUtc(p.year, p.month, p.day + add, hour, minute, tz);
    if (t > now.getTime()) return new Date(t);
  }
  // Unreachable for valid input (a matching day exists within 8 days).
  return new Date(now.getTime() + 86_400_000);
}
