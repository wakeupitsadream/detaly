#!/usr/bin/env node
// Copies what `output: 'standalone'` leaves out next to server.js:
//   apps/web/.next/static -> apps/web/.next/standalone/apps/web/.next/static
//   apps/web/public       -> apps/web/.next/standalone/apps/web/public
// Run after `pnpm --filter @detaly/web build`; then start
//   node apps/web/.next/standalone/apps/web/server.js
// (the same layout the Docker image uses: infra/docker/web.Dockerfile).
import { cp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const standaloneApp = path.join(webDir, '.next', 'standalone', 'apps', 'web');

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(from, to, { required }) {
  if (!(await exists(from))) {
    if (required) throw new Error(`missing ${path.relative(webDir, from)}: run next build first`);
    console.log(`[prepare-standalone] skip ${path.relative(webDir, from)} (absent)`);
    return;
  }
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
  console.log(
    `[prepare-standalone] ${path.relative(webDir, from)} -> ${path.relative(webDir, to)}`,
  );
}

if (!(await exists(path.join(standaloneApp, 'server.js')))) {
  console.error(
    `[prepare-standalone] ${path.relative(webDir, standaloneApp)}/server.js not found: run \`pnpm --filter @detaly/web build\``,
  );
  process.exit(1);
}

await copyDir(path.join(webDir, '.next', 'static'), path.join(standaloneApp, '.next', 'static'), {
  required: true,
});
await copyDir(path.join(webDir, 'public'), path.join(standaloneApp, 'public'), { required: false });
console.log('[prepare-standalone] done');
