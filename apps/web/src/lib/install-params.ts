/**
 * Install window numbers (docs/design.md, section 4) and their wording. No imports, so the
 * server planner (server/install/config.ts) and the client texts («Как мы считаем», the home
 * explanation) read the same values: change a number here and every text follows.
 */

/** Lifts the partner service can give to our clients at the same time. VERIFY with Лёша. */
export const INSTALL_LIFTS = 2;

/** A typical replacement job, minutes (filter, pads, plugs). VERIFY with Лёша. */
export const INSTALL_JOB_MIN = 120;

/** Supplier deliveries reach the service by this time of the pickup day. VERIFY with Лёша. */
export const INSTALL_ARRIVAL_TIME = '12:00';

/** A part already at the point can go on the lift no sooner than this, minutes. */
export const INSTALL_LEAD_MIN = 60;

/** Slot starts are tried with this step, minutes. */
export const INSTALL_STEP_MIN = 60;

/** How far ahead the planner looks, days. */
export const INSTALL_HORIZON_DAYS = 14;

const HOURS_WORDS: Readonly<Record<number, readonly [string, string]>> = {
  60: ['час', 'часа'],
  90: ['полтора часа', 'полутора часов'],
  120: ['два часа', 'двух часов'],
  150: ['два с половиной часа', 'двух с половиной часов'],
  180: ['три часа', 'трёх часов'],
  240: ['четыре часа', 'четырёх часов'],
};

/**
 * A duration in words: 'два часа' (nominative) or 'двух часов' (genitive, after «около»).
 * Durations without a word form fall back to minutes: '75 минут'.
 */
export function durationWords(minutes: number, form: 'nom' | 'gen' = 'nom'): string {
  const words = HOURS_WORDS[minutes];
  if (words) return form === 'nom' ? words[0] : words[1];
  const mod10 = minutes % 10;
  const mod100 = minutes % 100;
  if (form === 'gen') return `${minutes} минут`;
  if (mod10 === 1 && mod100 !== 11) return `${minutes} минута`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${minutes} минуты`;
  return `${minutes} минут`;
}

/** The planning horizon in words: 'две недели', 'неделю' or '10 дней'. */
export function horizonWords(days: number): string {
  if (days === 7) return 'неделю';
  if (days === 14) return 'две недели';
  if (days === 21) return 'три недели';
  const mod10 = days % 10;
  const mod100 = days % 100;
  if (mod10 === 1 && mod100 !== 11) return `${days} день`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${days} дня`;
  return `${days} дней`;
}
