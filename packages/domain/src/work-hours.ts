/**
 * Opening hours of the pickup point from the human-written PICKUP_HOURS
 * ("Пн–Пт 10:00–19:00", "Пн-Пт 9:00-19:00, Сб 10:00-16:00", "Ежедневно 9–21", "без выходных
 * 9-21"). Strict on purpose: anything not understood gives null, because the install window
 * computed from wrongly read hours would be a lie (docs/design.md, section 4).
 */

/** Working time of one day in minutes from local midnight: open < close, close <= 1440. */
export interface DayHours {
  openMin: number;
  closeMin: number;
}

/**
 * Seven days indexed like Date#getUTCDay(): 0 = Sunday, 1 = Monday ... 6 = Saturday. null is a
 * day off.
 */
export type WeekSchedule = readonly (DayHours | null)[];

/** Abbreviation and full-name stem of each day, indexed like getUTCDay(). */
const DAY_STEMS: readonly (readonly string[])[] = [
  ['вс', 'воскр'],
  ['пн', 'понед'],
  ['вт', 'вторн'],
  ['ср', 'сред'],
  ['чт', 'четв'],
  ['пт', 'пятн'],
  ['сб', 'суб'],
];
/** Monday-first order for ranges: "пт-пн" wraps over the weekend. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const DAY = '(понед|вторн|сред|четв|пятн|суб|воскр|пн|вт|ср|чт|пт|сб|вс)[а-я]*\\.?';
const TIME = '(\\d{1,2})(?:[:.](\\d{2}))?';

/** Sticky tokens, tried in this order at the current position. */
const TOKENS: readonly { kind: string; re: RegExp }[] = [
  // A dash before a word is punctuation ("Вс — выходной"); between times or days it is a range.
  { kind: 'space', re: /(?:[\s:.]|-(?=\s*[а-я]))+/y },
  { kind: 'range', re: new RegExp(`${TIME}\\s*-\\s*${TIME}`, 'y') },
  { kind: 'fromTo', re: new RegExp(`с\\s+${TIME}\\s+до\\s+${TIME}`, 'y') },
  { kind: 'dayRange', re: new RegExp(`${DAY}\\s*-\\s*${DAY}`, 'y') },
  { kind: 'day', re: new RegExp(DAY, 'y') },
  { kind: 'daily', re: /(ежедневно|каждый\s+день|без\s+выходных)/y },
  { kind: 'allDay', re: /круглосуточно/y },
  { kind: 'weekdays', re: /(по\s+будням|будни)/y },
  { kind: 'weekend', re: /выходные(?=\s*\d|\s+с\s)/y },
  { kind: 'closed', re: /(выходн(ой|ые)|не\s+работа[её]м|закрыто)/y },
];

function toMinutes(h: string | undefined, m: string | undefined): number | null {
  const hours = Number(h);
  const minutes = m === undefined ? 0 : Number(m);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

function dayIndex(token: string): number {
  return DAY_STEMS.findIndex((stems) => stems.includes(token));
}

function dayRange(from: number, to: number): number[] {
  const start = WEEK_ORDER.indexOf(from as (typeof WEEK_ORDER)[number]);
  const days: number[] = [];
  for (let i = 0; i < 7; i += 1) {
    const day = WEEK_ORDER[(start + i) % 7] as number;
    days.push(day);
    if (day === to) break;
  }
  return days;
}

type SegmentResult = { days: number[]; hours: DayHours | null | undefined } | null;

/** One comma/semicolon/line separated part: days and a time range (or "выходной"). */
function parseSegment(segment: string): SegmentResult {
  const days: number[] = [];
  let hours: DayHours | null | undefined;
  let allDay = false;
  let pos = 0;
  outer: while (pos < segment.length) {
    for (const { kind, re } of TOKENS) {
      re.lastIndex = pos;
      const m = re.exec(segment);
      if (m === null || m[0] === '') continue;
      pos = re.lastIndex;
      switch (kind) {
        case 'space':
          break;
        case 'range':
        case 'fromTo': {
          if (hours !== undefined) return null;
          const open = toMinutes(m[1], m[2]);
          const close = toMinutes(m[3], m[4]);
          if (open === null || close === null || close <= open) return null;
          hours = { openMin: open, closeMin: close };
          break;
        }
        case 'dayRange':
          days.push(...dayRange(dayIndex(m[1] as string), dayIndex(m[2] as string)));
          break;
        case 'day':
          days.push(dayIndex(m[1] as string));
          break;
        case 'daily':
          days.push(0, 1, 2, 3, 4, 5, 6);
          break;
        case 'allDay':
          if (hours !== undefined) return null;
          hours = { openMin: 0, closeMin: 1440 };
          allDay = true;
          break;
        case 'weekdays':
          days.push(1, 2, 3, 4, 5);
          break;
        case 'weekend':
          days.push(6, 0);
          break;
        case 'closed':
          if (hours !== undefined) return null;
          hours = null;
          break;
      }
      continue outer;
    }
    return null; // a character no token understands
  }
  // "Круглосуточно" alone means every day.
  if (allDay && days.length === 0) days.push(0, 1, 2, 3, 4, 5, 6);
  return { days, hours };
}

/**
 * Parses PICKUP_HOURS into a week. Parts are separated by `,`, `;` or a line break; dashes may
 * be `-`, `–` or `—`. A part with days but no time ("Пн, Ср, Пт 9-18") lends its days to the
 * next part with a time. Later parts override earlier ones ("Ежедневно 9-21, Вс выходной").
 * Returns null for anything not understood or a week without a single working day.
 */
export function parseWorkHours(text: string | null | undefined): WeekSchedule | null {
  if (typeof text !== 'string') return null;
  const normalized = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00a0/g, ' ')
    .trim();
  if (normalized === '') return null;

  const week: (DayHours | null)[] = [null, null, null, null, null, null, null];
  let pending: number[] = [];
  let anyAssigned = false;
  for (const raw of normalized.split(/[,;\n]+/)) {
    const segment = raw.trim();
    if (segment === '') continue;
    const parsed = parseSegment(segment);
    if (parsed === null) return null;
    const days = [...pending, ...parsed.days];
    if (parsed.hours === undefined) {
      // Days only: they wait for the time of the next part.
      if (parsed.days.length === 0) return null;
      pending = days;
      continue;
    }
    if (days.length === 0) return null; // a time without days is ambiguous
    for (const day of days) week[day] = parsed.hours;
    pending = [];
    anyAssigned = true;
  }
  if (pending.length > 0 || !anyAssigned) return null;
  return week.some((day) => day !== null) ? week : null;
}
