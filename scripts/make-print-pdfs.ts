/**
 * The two static print forms of phase 1C (docs/phase-1c-implementation.md decision С23; PLAN
 * section 6: «Памятка и акт выдачи — два статических PDF-шаблона в репозитории (без генерации)»):
 *
 *   scripts/print-templates/pamyatka.html -> apps/web/public/print/pamyatka-vozvrat.pdf
 *   scripts/print-templates/akt.html      -> apps/web/public/print/akt-vydachi.pdf
 *
 * Run once after a template changes and commit the PDFs:
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --import tsx scripts/make-print-pdfs.ts
 *
 * Chromium of the web package's Playwright (@playwright/test 1.56.1) prints the HTML to A4.
 * Nothing is substituted: the brand and the seller requisites stay blank lines filled in by
 * hand (they live only in env, never in a static file). The PDFs are served as they are; the
 * site never generates documents.
 */
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(ROOT, 'scripts', 'print-templates');
const OUT = join(ROOT, 'apps', 'web', 'public', 'print');

export const PRINT_FORMS = [
  { template: 'pamyatka.html', pdf: 'pamyatka-vozvrat.pdf' },
  { template: 'akt.html', pdf: 'akt-vydachi.pdf' },
] as const;

/** The slice of the Playwright API this script uses (the package lives in apps/web). */
interface PdfPage {
  setContent(html: string, options: { waitUntil: 'load' }): Promise<void>;
  pdf(options: {
    path: string;
    format: 'A4';
    printBackground: boolean;
    preferCSSPageSize: boolean;
  }): Promise<Buffer>;
}
interface PdfBrowser {
  newPage(): Promise<PdfPage>;
  close(): Promise<void>;
}
interface Chromium {
  launch(options: { headless: boolean }): Promise<PdfBrowser>;
}

/** @playwright/test is a dependency of apps/web, not of the root: resolve it from there. */
async function loadChromium(): Promise<Chromium> {
  const require = createRequire(join(ROOT, 'apps', 'web', 'package.json'));
  const entry = require.resolve('@playwright/test');
  // A CommonJS package: its exports may arrive as named exports or under `default`.
  const playwright = (await import(pathToFileURL(entry).href)) as {
    chromium?: Chromium;
    default?: { chromium?: Chromium };
  };
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) throw new Error('@playwright/test has no chromium export');
  return chromium;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const form of PRINT_FORMS) {
      const html = await readFile(join(TEMPLATES, form.template), 'utf8');
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const path = join(OUT, form.pdf);
      await page.pdf({ path, format: 'A4', printBackground: true, preferCSSPageSize: true });
      const { size } = await stat(path);
      console.log(`[print] ${form.template} -> apps/web/public/print/${form.pdf} (${size} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error('[print] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
