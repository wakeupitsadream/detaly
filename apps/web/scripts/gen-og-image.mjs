// The share card public/images/og.png, 1200×630 (audit perf-2; lib/seo.ts links it as og:image):
// the brand red with «Автозапчасти в Оренбурге» in large white type and «по артикулу и VIN · дата
// получения заранее» under it. No brand name on the picture: BRAND_NAME comes from env and may
// change without a new picture. The red is read from --color-brand in src/app/globals.css.
//
// Drawn with ImageMagick (convert). Manrope ships only as woff2 (@fontsource), which ImageMagick
// cannot read, so a system face with Cyrillic is taken from fontconfig (fc-list): DejaVu Sans,
// else Liberation Sans or FreeSans. Run once after changing the wording or the brand red:
//   node apps/web/scripts/gen-og-image.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WIDTH = 1200;
const HEIGHT = 630;
const LEFT = 88;
const TITLE = ['Автозапчасти', 'в Оренбурге'];
const SUBTITLE = 'по артикулу и VIN · дата получения заранее';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const out = `${webDir}public/images/og.png`;

/** --color-brand of the design tokens: the picture follows the token, never a copy of it. */
function brandRed() {
  const css = readFileSync(`${webDir}src/app/globals.css`, 'utf8');
  const match = /--color-brand:\s*(#[0-9a-f]{6})\s*;/i.exec(css);
  if (!match) throw new Error('--color-brand not found in src/app/globals.css');
  return match[1];
}

/** The first installed face of these families in this style that covers Cyrillic. */
function font(styles) {
  for (const family of ['DejaVu Sans', 'Liberation Sans', 'FreeSans']) {
    for (const style of styles) {
      const listed = execFileSync('fc-list', [`${family}:style=${style}:lang=ru`, 'file'], {
        encoding: 'utf8',
      });
      const file = listed
        .split('\n')
        .map((line) => line.replace(/:\s*$/, '').trim())
        .find(Boolean);
      if (file) return file;
    }
  }
  throw new Error(`no ${styles.join('/')} face with Cyrillic: fc-list ':lang=ru' is empty`);
}

/** Width in px of one line of text set in this face and size. */
function textWidth(face, size, text) {
  const width = execFileSync(
    'convert',
    ['-font', face, '-pointsize', String(size), `label:${text}`, '-format', '%w', 'info:'],
    { encoding: 'utf8' },
  );
  return Number(width);
}

/** The largest size, up to `max`, at which every line fits the card between its margins. */
function fit(face, lines, max) {
  let size = max;
  while (size > 24 && lines.some((line) => textWidth(face, size, line) > WIDTH - 2 * LEFT)) {
    size -= 2;
  }
  return size;
}

const bold = font(['Bold']);
const regular = font(['Book', 'Regular']);
const titleSize = fit(bold, TITLE, 112);
const subtitleSize = fit(regular, [SUBTITLE], 42);
const lineGap = Math.round(titleSize * 1.12);

// Baselines from the top: the marker bar (the site's section marker, in white), the two title
// lines, the subtitle; the block sits a little above the middle of the card.
const barTop = 132;
const firstBaseline = barTop + 40 + Math.round(titleSize * 0.95);
const secondBaseline = firstBaseline + lineGap;
const subtitleBaseline = secondBaseline + Math.round(subtitleSize * 2.1);

execFileSync('convert', [
  '-size',
  `${WIDTH}x${HEIGHT}`,
  `xc:${brandRed()}`,
  '-fill',
  'white',
  '-draw',
  `roundrectangle ${LEFT},${barTop} ${LEFT + 120},${barTop + 12} 6,6`,
  '-font',
  bold,
  '-pointsize',
  String(titleSize),
  '-annotate',
  `+${LEFT}+${firstBaseline}`,
  TITLE[0],
  '-annotate',
  `+${LEFT}+${secondBaseline}`,
  TITLE[1],
  '-font',
  regular,
  '-pointsize',
  String(subtitleSize),
  '-fill',
  'rgba(255,255,255,0.92)',
  '-annotate',
  `+${LEFT}+${subtitleBaseline}`,
  SUBTITLE,
  '-strip',
  '-depth',
  '8',
  '-define',
  'png:compression-level=9',
  `PNG24:${out}`,
]);

console.log(
  `[gen-og-image] ${out}: ${WIDTH}x${HEIGHT}, title ${titleSize}px (${bold}), subtitle ${subtitleSize}px (${regular})`,
);
