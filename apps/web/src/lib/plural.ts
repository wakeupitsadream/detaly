/** Russian plural form: plural(3, 'позиция', 'позиции', 'позиций') -> 'позиции'. */
export function plural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(count);
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** "3 позиции": the header cart link, the mobile cart bar, the /search hint. */
export function cartCountLabel(count: number): string {
  return `${count} ${plural(count, 'позиция', 'позиции', 'позиций')}`;
}
