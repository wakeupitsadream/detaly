import { parseEnv } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEGAL_DIR,
  parseLegalFile,
  readLegalSources,
  renderLegal,
  sha256Hex,
} from './legal';

const location = { kind: 'offer', version: '2026-10-d1', sourcePath: 'legal/offer/2026-10-d1.md' };

describe('parseLegalFile', () => {
  it('splits frontmatter and normalizes the body', () => {
    const source = parseLegalFile(
      '\uFEFF---\r\ntitle: Публичная оферта\r\nkind: offer\r\nversion: 2026-10-d1\r\n---\r\n\r\nЧерновик.\r\n\r\n',
      location,
    );
    expect(source).toEqual({
      kind: 'offer',
      version: '2026-10-d1',
      title: 'Публичная оферта',
      body: 'Черновик.\n',
      sourcePath: 'legal/offer/2026-10-d1.md',
    });
  });

  it('rejects a missing frontmatter or one that disagrees with the file location', () => {
    expect(() => parseLegalFile('Черновик.', location)).toThrow(/missing frontmatter/);
    expect(() =>
      parseLegalFile('---\ntitle: X\nkind: privacy\nversion: 2026-10-d1\n---\nA', location),
    ).toThrow(/kind must be "offer"/);
    expect(() =>
      parseLegalFile('---\ntitle: X\nkind: offer\nversion: 2026-11\n---\nA', location),
    ).toThrow(/version must be "2026-10-d1"/);
    expect(() => parseLegalFile('---\nkind: offer\nversion: 2026-10-d1\n---\nA', location)).toThrow(
      /title is required/,
    );
  });
});

describe('renderLegal', () => {
  const env = parseEnv(
    minimalEnvSource({ SELLER_REQUISITES_INN: '123456789012', BRAND_NAME: 'Бренд' }),
  );
  const source = {
    kind: 'offer' as const,
    version: 'v1',
    title: '{{BRAND_NAME}}: оферта',
    body: 'ИНН {{SELLER_INN}}, ОГРНИП {{SELLER_OGRNIP}}\n',
    sourcePath: 'legal/offer/v1.md',
  };

  it('substitutes env values and hashes the final body', () => {
    const { rendered, problems } = renderLegal(source, env, 'draft');
    expect(problems).toEqual([]);
    expect(rendered.title).toBe('Бренд: оферта');
    expect(rendered.bodyMd).toBe('ИНН 123456789012, ОГРНИП [не задано: SELLER_OGRNIP]\n');
    expect(rendered.sha256).toBe(sha256Hex(rendered.bodyMd));
    expect(rendered.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires every value when publishing and rejects unknown placeholders', () => {
    expect(renderLegal(source, env, 'publish').problems).toEqual([
      'legal/offer/v1.md: SELLER_REQUISITES_OGRNIP is required to publish ({{SELLER_OGRNIP}})',
    ]);
    expect(renderLegal({ ...source, body: '{{NOPE}}' }, env, 'draft').problems).toEqual([
      'legal/offer/v1.md: unknown placeholder {{NOPE}}',
    ]);
  });
});

describe('repository content/legal', () => {
  it('has a valid file for every document kind', async () => {
    const sources = await readLegalSources(DEFAULT_LEGAL_DIR);
    expect(new Set(sources.map((s) => s.kind))).toEqual(
      new Set(['offer', 'privacy', 'consent_pd', 'consent_marketing', 'return_memo']),
    );
    const env = parseEnv(minimalEnvSource());
    for (const source of sources) {
      expect(renderLegal(source, env, 'draft').problems).toEqual([]);
    }
  });
});
