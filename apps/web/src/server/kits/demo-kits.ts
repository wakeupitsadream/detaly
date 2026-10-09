/**
 * The two sample kits of the demo (DEMO_MODE, docs/kits.md): written in the master's own format
 * and read by the same parser as /admin/kits, made of the bundled Rossko fixtures (synthetic
 * articles marked `_meta.synthetic`). They are samples of how a kit page looks, NOT applicability
 * data: every page and section that shows them carries «Пример набора — состав для
 * демонстрации, не для покупки» (KIT_DEMO_LABEL), and the demo never takes an order anyway.
 */
import { kitModelSlug, pickKitSlug } from '@detaly/domain';
import { parseKitText } from '@detaly/vin';
import type { KitLineRecord, KitRecord } from './catalog';

interface DemoKitSource {
  id: string;
  makeSlug: string;
  model: string;
  engine: string;
  yearsFrom: number;
  yearsTo: number | null;
  note: string | null;
  lines: string;
}

const SOURCES: readonly DemoKitSource[] = [
  {
    id: 'demo-lada-vesta',
    makeSlug: 'lada',
    model: 'Vesta',
    engine: '1.6 16V, 106 л.с.',
    yearsFrom: 2015,
    yearsTo: null,
    note: 'замена ≈ 1 ч',
    lines: `MANN W914/2 1 — Фильтр масляный
или KNECHT OC90
MANN C26003 1 — Фильтр воздушный
MANN CU1919 1 — Фильтр салонный
NGK BKR6E 4 — Свечи зажигания
или BOSCH FR7DCX+`,
  },
  {
    id: 'demo-hyundai-solaris',
    makeSlug: 'hyundai',
    model: 'Solaris',
    engine: '1.6, 123 л.с.',
    yearsFrom: 2017,
    yearsTo: 2022,
    note: 'замена ≈ 1,5 ч',
    lines: `KNECHT OC90 1 — Фильтр масляный
или MAHLE OC90
KNECHT LX2046 1 — Фильтр воздушный
NGK BKR6E 4 — Свечи зажигания
TRW GDB1330 1 — Колодки тормозные передние`,
  },
];

/** When the samples were «published»: a fixed date, they never change. */
const DEMO_PUBLISHED_AT = new Date('2026-10-09T00:00:00Z');

function demoKit(source: DemoKitSource): KitRecord {
  const parsed = parseKitText(source.lines);
  if (parsed.errors.length > 0) {
    throw new Error(`demo kit ${source.id}: line ${parsed.errors[0]?.line} cannot be read`);
  }
  const lines: KitLineRecord[] = [];
  let main: KitLineRecord | null = null;
  parsed.lines.forEach((line, index) => {
    const record: KitLineRecord = {
      id: `${source.id}-${index + 1}`,
      position: index + 1,
      role: line.role,
      brand: line.brand,
      article: line.article,
      qty: line.qty,
      alternativeOf: line.alternative && main !== null ? main.id : null,
    };
    if (!line.alternative) main = record;
    lines.push(record);
  });
  return {
    id: source.id,
    makeSlug: source.makeSlug,
    model: source.model,
    modelSlug: kitModelSlug(source.model),
    engine: source.engine,
    yearsFrom: source.yearsFrom,
    yearsTo: source.yearsTo,
    slug: pickKitSlug(source.engine, source.yearsFrom, new Set()),
    note: source.note,
    status: 'published',
    publishedAt: DEMO_PUBLISHED_AT,
    updatedAt: DEMO_PUBLISHED_AT,
    version: 'demo',
    demo: true,
    lines,
  };
}

/** The samples, in the order of the home page's makes. */
export const DEMO_KITS: readonly KitRecord[] = SOURCES.map(demoKit);

/** A sample by id (the cart button of the demo). */
export function demoKitById(id: string): KitRecord | null {
  return DEMO_KITS.find((kit) => kit.id === id) ?? null;
}
