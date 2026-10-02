/**
 * Filter for goods we do not sell online (mandatory "Честный знак" marking: oils, tyres,
 * antifreeze, brake fluid). Grammar of a pattern (types.ts ExcludedRule):
 * - text is lower-cased and 'ё' is treated as 'е';
 * - words are maximal runs of letters and digits ('DOT-4' -> 'dot', '4');
 * - a pattern is a space-separated list of tokens; every token must match some word;
 * - a token without '*' must equal a whole word, a token ending with '*' is a word prefix.
 * keyword rules are matched against the item name, group rules against the product group.
 */
import type { ExcludableItem, ExcludedRule, ExclusionResult } from './types';

const WORD_RE = /[\p{L}\p{N}]+/gu;
const TOKEN_RE = /^[\p{L}\p{N}]+\*?$/u;

/** Lower case, 'ё' -> 'е'. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е');
}

export function splitWords(text: string): string[] {
  return normalizeText(text).match(WORD_RE) ?? [];
}

interface PatternToken {
  stem: string;
  prefix: boolean;
}

/** Parses a pattern; returns null when it is empty or contains invalid tokens. */
export function parseExcludedPattern(pattern: string): PatternToken[] | null {
  const raw = normalizeText(pattern)
    .trim()
    .split(/\s+/u)
    .filter((t) => t !== '');
  if (raw.length === 0) return null;
  const tokens: PatternToken[] = [];
  for (const token of raw) {
    if (!TOKEN_RE.test(token)) return null;
    const prefix = token.endsWith('*');
    tokens.push({ stem: prefix ? token.slice(0, -1) : token, prefix });
  }
  return tokens;
}

/** For admin forms: a pattern that would never match is rejected up front. */
export function isValidExcludedPattern(pattern: string): boolean {
  return parseExcludedPattern(pattern) !== null;
}

function matchesWords(words: readonly string[], tokens: readonly PatternToken[]): boolean {
  return tokens.every((token) =>
    words.some((word) => (token.prefix ? word.startsWith(token.stem) : word === token.stem)),
  );
}

/** True when `text` matches `pattern` under the grammar above. Invalid patterns never match. */
export function matchesExcludedPattern(text: string, pattern: string): boolean {
  const tokens = parseExcludedPattern(pattern);
  if (tokens === null) return false;
  return matchesWords(splitWords(text), tokens);
}

/** First matching rule wins; its reason (or pattern when the reason is empty) is returned. */
export function isExcluded(item: ExcludableItem, rules: readonly ExcludedRule[]): ExclusionResult {
  const nameWords = splitWords(item.name);
  const groupWords = item.group ? splitWords(item.group) : [];
  for (const rule of rules) {
    const tokens = parseExcludedPattern(rule.pattern);
    if (tokens === null) continue;
    const words = rule.kind === 'keyword' ? nameWords : groupWords;
    if (words.length > 0 && matchesWords(words, tokens)) {
      const reason = rule.reason?.trim() ? rule.reason.trim() : rule.pattern;
      return { excluded: true, reason };
    }
  }
  return { excluded: false, reason: null };
}

/**
 * Default keyword rules (docs/phase0-implementation.md section 4): whole words, not the
 * 'масл' prefix, which would also hide oil filters and valve stem seals.
 */
export const DEFAULT_EXCLUDED_RULES: readonly ExcludedRule[] = [
  { kind: 'keyword', pattern: 'масло', reason: 'Маркируемый товар: масла' },
  { kind: 'keyword', pattern: 'масла', reason: 'Маркируемый товар: масла' },
  { kind: 'keyword', pattern: 'шина', reason: 'Маркируемый товар: шины' },
  { kind: 'keyword', pattern: 'шины', reason: 'Маркируемый товар: шины' },
  { kind: 'keyword', pattern: 'антифриз*', reason: 'Маркируемый товар: антифризы' },
  { kind: 'keyword', pattern: 'тосол', reason: 'Маркируемый товар: антифризы' },
  {
    kind: 'keyword',
    pattern: 'жидкость тормозн*',
    reason: 'Маркируемый товар: тормозные жидкости',
  },
];
