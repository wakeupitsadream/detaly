/**
 * Wording of the price benchmark and the markup editor (/admin/prices, /admin/pricing): signed
 * money and percents, terms, the hint of a group. Plain functions (tested without React).
 */
import {
  formatBpPercent,
  formatPercentPoints,
  formatRub,
  type BenchmarkHint,
  type MarkupRule,
} from '@detaly/domain';

/** −4 200 → '−42 ₽', 12 000 → '+120 ₽', 0 → '0 ₽'. */
export function signedRub(kop: number): string {
  if (kop === 0) return formatRub(0);
  return `${kop < 0 ? '\u2212' : '+'}${formatRub(Math.abs(kop))}`;
}

/** −1015 → '−10,15%', 667 → '+6,67%', 0 → '0%'. */
export function signedPercent(bp: number): string {
  return bp > 0 ? `+${formatBpPercent(bp)}` : formatBpPercent(bp);
}

/** Our days minus theirs: −2 → 'мы быстрее на 2 дн.', 0 → 'так же', null → '—'. */
export function etaDiffText(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'так же';
  return days < 0 ? `мы быстрее на ${-days} дн.` : `мы дольше на ${days} дн.`;
}

/** A hint as a short instruction for the editor. */
export function hintText(hint: BenchmarkHint): string {
  switch (hint.kind) {
    case 'raise':
      return `можно поднять до ${formatPercentPoints(hint.newDeltaBp)} п.п.`;
    case 'lower':
      return `стоит снизить на ${formatPercentPoints(hint.byBp).replace('+', '')} п.п. (до ${formatPercentPoints(hint.newDeltaBp)})`;
    case 'few':
      return `мало данных: нужно от ${hint.needed} позиций`;
    case 'keep':
      if (hint.reason === 'slower') return 'мы дешевле, но везём дольше — оставить';
      if (hint.reason === 'bounds') return 'упирается в пол или потолок — оставить';
      return 'цены на уровне — оставить';
  }
}

/** Tone of a hint: raise and lower stand out, the rest is muted. */
export function hintTone(hint: BenchmarkHint): 'raise' | 'lower' | 'none' {
  return hint.kind === 'raise' ? 'raise' : hint.kind === 'lower' ? 'lower' : 'none';
}

/** A range of the base table: 'до 1 000 ₽', '1 000 – 5 000 ₽', 'от 5 000 ₽'. */
export function rangeLabel(rule: Pick<MarkupRule, 'fromKop' | 'toKop'>): string {
  if (rule.fromKop === 0 && rule.toKop !== null) return `до ${formatRub(rule.toKop)}`;
  if (rule.toKop === null) return `от ${formatRub(rule.fromKop)}`;
  return `${formatRub(rule.fromKop).replace(/\s₽$/u, '')} – ${formatRub(rule.toKop)}`;
}

/** A delta as typed in the editor: '' for 0, '+3', '−1,5'. */
export function deltaInputValue(bp: number): string {
  return bp === 0 ? '' : formatPercentPoints(bp);
}
