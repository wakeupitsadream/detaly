// The Caddy access and default logs redact secret order tokens (infra/Caddyfile, 152-FZ): every
// route of the site that carries an order or proposal token in its path must be covered by the
// `request>uri regexp` filter, the client API routes of phase 1B and the proposal / VIN link
// routes of phase 1C included. Redirect targets (Location) are dropped from the logs, and API
// request bodies are capped at 12 MB (photo forms, decision С19).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CADDYFILE = readFileSync(join(ROOT, 'infra/Caddyfile'), 'utf8');
const APP_DIR = join(ROOT, 'apps/web/src/app');

/** Every `request>uri regexp <re> <replacement>` of the Caddyfile. */
function uriFilters(): { re: RegExp; replacement: string }[] {
  return [...CADDYFILE.matchAll(/^\s*request>uri regexp (\S+) (\S+)\s*$/gmu)].map((m) => ({
    // Go RE2 and JavaScript agree on this subset; `$1` is the group in both replacements.
    re: new RegExp(m[1] as string, 'u'),
    replacement: m[2] as string,
  }));
}

function redact(uri: string): string[] {
  return uriFilters().map(({ re, replacement }) => uri.replace(re, replacement));
}

/** Dynamic segments that hold a secret: order / proposal tokens and messenger link tokens. */
const SECRET_SEGMENTS = new Set(['[token]', '[link]']);

/** URL prefixes of app routes whose path has a secret segment: /o/[token], /vin/sent/[link]. */
function tokenRoutes(dir = APP_DIR): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) continue;
    if (SECRET_SEGMENTS.has(name)) {
      const url = relative(APP_DIR, path)
        .split(sep)
        // Route groups such as (site) are not part of the URL.
        .filter((segment) => !/^\(.*\)$/u.test(segment))
        .join('/');
      found.push(`/${url}`);
    }
    found.push(...tokenRoutes(path));
  }
  return found;
}

const TOKEN = 'Zk3vQ9x_LmP2-abcdefghijklmnopqrstuvwxyz0123';

describe('infra/Caddyfile log filter', () => {
  it('has the same uri filter in the default and the access log', () => {
    const filters = uriFilters();
    expect(filters).toHaveLength(2);
    expect(String(filters[0]?.re)).toBe(String(filters[1]?.re));
    expect(filters[0]?.replacement).toBe(filters[1]?.replacement);
  });

  it.each([
    [`/o/${TOKEN}`, '/o/[redacted]'],
    [`/o/${TOKEN}?paid=1`, '/o/[redacted]?paid=1'],
    [`/p/${TOKEN}`, '/p/[redacted]'],
    [`/api/orders/${TOKEN}/pay`, '/api/orders/[redacted]/pay'],
    [`/api/orders/${TOKEN}/actions`, '/api/orders/[redacted]/actions'],
    [`/api/orders/${TOKEN}/cancel`, '/api/orders/[redacted]/cancel'],
    // phase 1C
    [`/api/orders/${TOKEN}/link`, '/api/orders/[redacted]/link'],
    [`/api/orders/${TOKEN}/install/cancel`, '/api/orders/[redacted]/install/cancel'],
    [`/api/orders/${TOKEN}/claims`, '/api/orders/[redacted]/claims'],
    [
      `/api/orders/${TOKEN}/photos/0192d8a4-0000-7000-8000-000000000001`,
      '/api/orders/[redacted]/photos/0192d8a4-0000-7000-8000-000000000001',
    ],
    [`/api/proposals/${TOKEN}/take`, '/api/proposals/[redacted]/take'],
    [`/vin/sent/${TOKEN}`, '/vin/sent/[redacted]'],
  ])('redacts the token of %s', (uri, expected) => {
    for (const result of redact(uri)) {
      expect(result).toBe(expected);
      expect(result).not.toContain(TOKEN);
    }
  });

  it('leaves routes without secrets as they are', () => {
    for (const uri of [
      '/',
      '/search?q=w914',
      '/api/cart/items/1',
      '/admin/orders/abc',
      '/vin',
      '/vin/sent',
      '/vin/sent?demo=1',
      '/api/vin',
      '/pricing',
    ]) {
      expect(redact(uri)).toEqual([uri, uri]);
    }
  });

  it('covers every route of the site with a [token] segment', () => {
    const routes = tokenRoutes();
    expect(routes).toEqual(expect.arrayContaining(['/o/[token]', '/api/orders/[token]']));
    for (const route of routes) {
      const uri = `${route.replace(/\[(token|link)\]/u, TOKEN)}/x`;
      for (const result of redact(uri)) expect(result, route).not.toContain(TOKEN);
    }
  });
});

describe('infra/Caddyfile phase 1C', () => {
  it('drops the Location response header from both logs (deep links, proposal tokens)', () => {
    const deletes = [...CADDYFILE.matchAll(/^\s*resp_headers>Location delete\s*$/gmu)];
    expect(deletes).toHaveLength(2);
  });

  it('caps API request bodies at 12 MB, the size of the photo forms', () => {
    expect(CADDYFILE).toMatch(
      /@api path \/api\/\*\s*\n\s*request_body @api \{\s*\n\s*max_size 12MB/u,
    );
  });
});
