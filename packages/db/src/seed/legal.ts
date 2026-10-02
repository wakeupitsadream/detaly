// Legal texts: content/legal/<kind>/<version>.md -> document_versions.
//
// - Requisites are substituted from env ({{SELLER_INN}} etc.); the sha256 is taken over the
//   final body, so consents prove exactly which text the client saw.
// - LEGAL_<KIND>_VERSION selects the published version. Without it every version stays a
//   draft and pages show the latest draft with a "черновик" banner.
// - A published row is immutable: if its text (or title) would change, the seed fails and a
//   new version file is required. Drafts are updated in place.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '@detaly/config';
import { DOCUMENT_KINDS, isOneOf, type DocumentKind } from '@detaly/domain/statuses';
import type { LegalDocumentFrontmatter } from '@detaly/domain/types';
import { and, eq } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import type { Executor } from '../executor';
import { documentVersions } from '../schema';

/**
 * Repository content/legal, resolved from packages/db/src/seed. path.join instead of a
 * `new URL` of a string literal against import.meta.url, which bundlers treat as an asset.
 */
export const DEFAULT_LEGAL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'content',
  'legal',
);

/** Env variable selecting the published version per document kind. */
export const LEGAL_VERSION_ENV = {
  offer: 'LEGAL_OFFER_VERSION',
  privacy: 'LEGAL_PRIVACY_VERSION',
  consent_pd: 'LEGAL_CONSENT_PD_VERSION',
  consent_marketing: 'LEGAL_CONSENT_MARKETING_VERSION',
  return_memo: 'LEGAL_RETURN_MEMO_VERSION',
} as const satisfies Record<DocumentKind, keyof Env>;

/** Placeholders allowed in legal texts: {{NAME}} -> env value. */
export const LEGAL_PLACEHOLDERS = {
  BRAND_NAME: 'BRAND_NAME',
  SELLER_NAME: 'SELLER_REQUISITES_NAME',
  SELLER_INN: 'SELLER_REQUISITES_INN',
  SELLER_OGRNIP: 'SELLER_REQUISITES_OGRNIP',
  SELLER_ADDRESS: 'SELLER_REQUISITES_ADDRESS',
  SELLER_EMAIL: 'SELLER_REQUISITES_EMAIL',
  SELLER_PHONE: 'SELLER_REQUISITES_PHONE',
  PICKUP_POINT_NAME: 'PICKUP_POINT_NAME',
  PICKUP_ADDRESS: 'PICKUP_ADDRESS',
  PICKUP_HOURS: 'PICKUP_HOURS',
  PICKUP_PHONE: 'PICKUP_PHONE',
  RKN_NOTICE_NUMBER: 'RKN_NOTICE_NUMBER',
  SITE_URL: 'APP_BASE_URL',
} as const satisfies Record<string, keyof Env>;
export type LegalPlaceholder = keyof typeof LEGAL_PLACEHOLDERS;

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export class LegalSeedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Legal documents seed failed:\n  ${problems.join('\n  ')}`);
    this.name = 'LegalSeedError';
    this.problems = problems;
  }
}

export interface LegalSource {
  kind: DocumentKind;
  version: string;
  title: string;
  /** Body without frontmatter, LF line endings, placeholders not yet substituted. */
  body: string;
  /** Path relative to the legal dir parent, e.g. 'legal/offer/2026-10-d1.md'. */
  sourcePath: string;
}

export interface RenderedLegal extends Omit<LegalSource, 'body'> {
  bodyMd: string;
  sha256: string;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Splits `---\nyaml\n---\nbody` and validates the frontmatter against the file location. */
export function parseLegalFile(
  raw: string,
  location: { kind: string; version: string; sourcePath: string },
): LegalSource {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${location.sourcePath}: missing frontmatter (--- ... ---)`);
  const data = parseYaml(match[1] ?? '') as Partial<
    Record<keyof LegalDocumentFrontmatter, unknown>
  >;
  const problems: string[] = [];
  if (typeof data?.title !== 'string' || data.title.trim() === '')
    problems.push('title is required');
  if (data?.kind !== location.kind) problems.push(`kind must be "${location.kind}"`);
  if (String(data?.version) !== location.version) {
    problems.push(`version must be "${location.version}" (the file name)`);
  }
  if (!isOneOf(DOCUMENT_KINDS, location.kind)) problems.push(`unknown kind "${location.kind}"`);
  if (problems.length > 0 || !isOneOf(DOCUMENT_KINDS, location.kind)) {
    throw new Error(`${location.sourcePath}: ${problems.join('; ')}`);
  }
  const body = `${(match[2] ?? '').replace(/^\n+/, '').trimEnd()}\n`;
  return {
    kind: location.kind,
    version: location.version,
    title: (data.title as string).trim(),
    body,
    sourcePath: location.sourcePath,
  };
}

/** Reads every content/legal/<kind>/<version>.md (sorted by kind, then version). */
export async function readLegalSources(legalDir: string): Promise<LegalSource[]> {
  const sources: LegalSource[] = [];
  const kinds = (await readdir(legalDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const base = path.basename(legalDir);
  for (const kind of kinds) {
    if (!isOneOf(DOCUMENT_KINDS, kind)) {
      throw new Error(`content/legal/${kind}: unknown document kind`);
    }
    const files = (await readdir(path.join(legalDir, kind)))
      .filter((name) => name.endsWith('.md'))
      .sort();
    for (const file of files) {
      const version = file.slice(0, -'.md'.length);
      const raw = await readFile(path.join(legalDir, kind, file), 'utf8');
      sources.push(parseLegalFile(raw, { kind, version, sourcePath: `${base}/${kind}/${file}` }));
    }
  }
  return sources;
}

/**
 * Substitutes {{PLACEHOLDER}} values from env. Unknown placeholders always fail. A missing
 * value fails for a document being published and becomes a visible marker in a draft.
 */
export function renderLegal(
  source: LegalSource,
  env: Env,
  mode: 'draft' | 'publish',
): { rendered: RenderedLegal; problems: string[] } {
  const problems: string[] = [];
  const substitute = (text: string) =>
    text.replace(PLACEHOLDER_RE, (whole, name: string) => {
      if (!Object.hasOwn(LEGAL_PLACEHOLDERS, name)) {
        problems.push(`${source.sourcePath}: unknown placeholder ${whole}`);
        return whole;
      }
      const envKey = LEGAL_PLACEHOLDERS[name as LegalPlaceholder];
      const value = env[envKey];
      if (value === undefined || value === '') {
        if (mode === 'publish') {
          problems.push(`${source.sourcePath}: ${envKey} is required to publish ({{${name}}})`);
        }
        return `[не задано: ${name}]`;
      }
      return String(value);
    });
  const bodyMd = substitute(source.body);
  const title = substitute(source.title);
  return {
    rendered: {
      kind: source.kind,
      version: source.version,
      title,
      bodyMd,
      sha256: sha256Hex(bodyMd),
      sourcePath: source.sourcePath,
    },
    problems: [...new Set(problems)],
  };
}

export interface LegalSeedOptions {
  /** Directory with <kind>/<version>.md files; default: repository content/legal. */
  legalDir?: string;
  now?: Date;
}

export interface LegalSeedResult {
  inserted: string[];
  updated: string[];
  published: string[];
}

/**
 * Syncs content/legal into document_versions. Throws LegalSeedError (and writes nothing when
 * called inside a transaction) when a published text changed, a selected version has no file,
 * or a placeholder is unknown or unset for publication.
 */
export async function seedLegal(
  db: Executor,
  env: Env,
  options: LegalSeedOptions = {},
): Promise<LegalSeedResult> {
  const legalDir = options.legalDir ?? DEFAULT_LEGAL_DIR;
  const now = options.now ?? new Date();
  const sources = await readLegalSources(legalDir);
  const result: LegalSeedResult = { inserted: [], updated: [], published: [] };
  const problems: string[] = [];

  for (const kind of DOCUMENT_KINDS) {
    const wanted = env[LEGAL_VERSION_ENV[kind]];
    if (wanted && !sources.some((s) => s.kind === kind && s.version === wanted)) {
      problems.push(`${LEGAL_VERSION_ENV[kind]}=${wanted}: no file ${kind}/${wanted}.md`);
    }
  }

  for (const source of sources) {
    const label = `${source.kind}/${source.version}`;
    const publish = env[LEGAL_VERSION_ENV[source.kind]] === source.version;
    const [existing] = await db
      .select()
      .from(documentVersions)
      .where(
        and(eq(documentVersions.kind, source.kind), eq(documentVersions.version, source.version)),
      )
      .for('update');
    const isPublished = Boolean(existing?.publishedAt) || publish;
    const { rendered, problems: renderProblems } = renderLegal(
      source,
      env,
      isPublished ? 'publish' : 'draft',
    );
    problems.push(...renderProblems);
    if (renderProblems.length > 0) continue;

    if (!existing) {
      await db.insert(documentVersions).values({ ...rendered, publishedAt: publish ? now : null });
      result.inserted.push(label);
      if (publish) result.published.push(label);
      continue;
    }

    const sameText = existing.sha256 === rendered.sha256 && existing.title === rendered.title;
    if (existing.publishedAt) {
      if (!sameText) {
        problems.push(
          `${label}: published ${existing.publishedAt.toISOString()} and its text changed ` +
            `(sha256 ${existing.sha256} -> ${rendered.sha256}); create a new version file instead`,
        );
      }
      continue;
    }

    if (!sameText || existing.sourcePath !== rendered.sourcePath || publish) {
      await db
        .update(documentVersions)
        .set({ ...rendered, publishedAt: publish ? now : null })
        .where(eq(documentVersions.id, existing.id));
      if (!sameText || existing.sourcePath !== rendered.sourcePath) result.updated.push(label);
      if (publish) result.published.push(label);
    }
  }

  if (problems.length > 0) throw new LegalSeedError(problems);
  return result;
}
